// 完整的 Express.js xApp 部署與管理 API + MySQL 整合
const axios = require('axios');
const express = require('express');
const { exec, spawn, execSync } = require('child_process');
const fs = require('fs');
const mysql = require('mysql2');
const app = express();
const PORT = 9100;

const XAPP_DIR = "/home/ubuntu/flexric/examples/xApp/c/ctrl";
const BUILD_DIR = "/home/ubuntu/flexric/build";
const SNAPSHOT_DIR = '/home/ubuntu/xapp-snapshots';

const INFLUX_HOST = 'http://192.168.31.133:8086';
const INFLUX_DB = 'influx';

app.use(express.json());

// 建立 MySQL 連線池
const db = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'rtlab666',
    database: 'a1db'
});

app.use(express.json());

// 副程式


async function stopSimulation() {
  await axios.post('http://192.168.31.133:8000/stop_simulation', {}, {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function startSimulation() {
  await axios.post('http://192.168.31.133:8000/start_simulation', {
    flexric: "true",
    e2TermIp: "127.0.0.1",
    hoSinrDifference: 3,
    indicationPeriodicity: 0.1,
    simTime: 10000,
    KPM_E2functionID: 2,
    RC_E2functionID: 3,
    N_Ues: 10,
    N_MmWaveEnbNodes: 3,
    CenterFrequency: 3.5e9,
    Bandwidth: 20e6,
    IntersideDistanceUEs: 350,
    IntersideDistanceCells: 350,
    scenario: "scratch/scenario-zero-with_parallel_loging.cc",
    flags: "true"
  }, {
    headers: { 'Content-Type': 'application/json' }
  });
}

// 建立 xApp
app.post('/create', async (req, res) => {
  const { app_name, policy_id } = req.body;
  const numericPolicyId = typeof policy_id === 'string' ? parseInt(policy_id, 10) : policy_id;

  if (!/^[a-zA-Z0-9_-]+$/.test(app_name)) {
    return res.status(400).send({ error: 'Invalid app_name' });
  }
  if (isNaN(numericPolicyId)) {
    return res.status(400).send({ error: `policy_id 必須是數字，目前為: ${policy_id}` });
  }

  const templatePath = `${XAPP_DIR}/template`;
  const newAppPath = `${XAPP_DIR}/${app_name}`;

  if (fs.existsSync(newAppPath)) {
    return res.status(400).send({ error: `App directory ${app_name} already exists.` });
  }

  try {
    fs.cpSync(templatePath, newAppPath, { recursive: true });

    const createdAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await db.promise().execute(
      `INSERT INTO xapp_policies (app_name, policy_type_id, created_at, is_active, is_running) VALUES (?, ?, ?, 1, 0)`,
      [app_name, numericPolicyId, createdAt]
    );

    const cmakePath = `${XAPP_DIR}/CMakeLists.txt`;
    const cmakeContent = fs.readFileSync(cmakePath, 'utf-8');
    const marker = `# === MCP-AUTO-XAPP ===`;
    const insertion = `add_executable(${app_name}
  ${app_name}/main.c
  ${app_name}/common.c
  ${app_name}/influx.c
  ${app_name}/foreachcell.c
  ${app_name}/ho.c
  ${app_name}/cell_down.c
  ${app_name}/target_selector.c
  civetweb/src/civetweb.c
  ../../../../src/util/alg_ds/alg/defer.c
)

target_compile_definitions(${app_name} PRIVATE USE_SSL NO_SSL_DL OPENSSL_API_1_1)

target_link_libraries(${app_name}
  e42_xapp
  pthread
  sctp
  dl
  CURL::libcurl
  \${OPENSSL_LIBRARIES}
)
`;

    if (!cmakeContent.includes(`add_executable(${app_name}`)) {
      const updated = cmakeContent.replace(marker, `${marker}\n\n${insertion}`);
      fs.writeFileSync(cmakePath, updated, 'utf-8');
    }

    res.send({ status: 'success', message: `Created and registered ${app_name}` });
  } catch (err) {
    console.error('[CREATE xApp ERROR]', err);
    res.status(500).send({ error: 'Failed to create xApp', detail: err.message });
  }
});


// 編譯
app.post('/compile', (req, res) => {
    const { app_name } = req.body;

    if (!app_name || typeof app_name !== 'string') {
        return res.status(400).send({ error: 'app_name 必須是字串' });
    }

    const command = `cd ${BUILD_DIR} && sudo cmake .. -DE2AP_VERSION=E2AP_V1 -DKPM_VERSION=KPM_V3_00 && sudo make -j8 ${app_name}`;
    exec(command, { maxBuffer: 1024 * 500 }, (error, stdout, stderr) => {
        if (error) {
            return res.status(500).send({
                error: 'Compilation failed',
                stdout: stdout,
                stderr: stderr,
                message: '請參考 stderr 回傳的錯誤訊息進行修正'
            });
        }
        res.send({ message: 'Compilation successful', output: stdout });
    });
});


// 執行 xApp
app.post('/run', (req, res) => {
    const { app_name } = req.body;
    const logFile = `/tmp/${app_name}.log`;
    const pidFile = `/tmp/${app_name}.pid`;
    const maxLines = 500;
    const binaryPath = `${BUILD_DIR}/examples/xApp/c/ctrl/${app_name}`;

    // Step 1: 檢查 DB 中是否存在此 app_name 且 is_active=1
    db.query("SELECT * FROM xapp_policies WHERE app_name = ? AND is_active = 1", [app_name], (err, results) => {
        if (err) return res.status(500).send({ error: 'DB query failed', details: err });
        if (results.length === 0) return res.status(404).send({ error: 'App not found or not active in database' });

        // Step 2: 檢查 binary 是否存在
        if (!fs.existsSync(binaryPath)) {
            return res.status(400).send({ error: `Executable not found: ${binaryPath}` });
        }

        const logStream = fs.openSync(logFile, 'a');

        // Step 3: 執行
        const child = spawn(binaryPath, [], {
            detached: true,
            stdio: ['ignore', logStream, logStream],
            cwd: `${BUILD_DIR}/examples/xApp/c/ctrl`,
        });

        child.unref();
        fs.writeFileSync(pidFile, child.pid.toString());

        // Step 4: 裁剪 log
        setTimeout(() => {
            exec(`tail -n ${maxLines} ${logFile} > ${logFile}.tmp && mv ${logFile}.tmp ${logFile}`);
        }, 2000);

        // Step 5: 更新 DB 狀態
        db.query("UPDATE xapp_policies SET is_running = 1 WHERE app_name = ?", [app_name]);

        res.send({
            message: 'xApp started successfully',
            log_file: logFile,
            pid: child.pid,
        });
    });
});


// 查詢狀態
app.get('/status_all', (req, res) => {
    db.query('SELECT app_name, is_running FROM xapp_policies', (err, rows) => {
      if (err) return res.status(500).send('資料庫錯誤');
      const result = rows.map(row => ({
        app_name: row.app_name,
        status: row.is_running === 1 ? 'running' : 'stopped'
      }));
      res.json(result);
    });
  });
  

// 停止 xApp
app.post('/stop', async (req, res) => {
    const { app_name } = req.body;
    const pidFile = `/tmp/${app_name}.pid`;
  
    try {
      // Step 1: 停止模擬器
      await stopSimulation();
  
      if (!fs.existsSync(pidFile)) {
        await startSimulation();  // 模擬器還是要重啟
        return res.status(404).send({ error: 'PID file not found, xApp may not be running' });
      }
  
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      const cmdLine = execSync(`ps -p ${pid} -o cmd=`).toString().trim();
  
      if (!cmdLine.includes(app_name)) {
        await startSimulation();
        return res.status(400).send({
          error: 'PID does not match expected xApp binary. Aborting kill.',
          detail: cmdLine
        });
      }
  
      process.kill(pid, 'SIGTERM');
  
      let responseSent = false;
  
      setTimeout(async () => {
        try {
          process.kill(pid, 0); // 還在 → 強制 kill
          process.kill(pid, 'SIGKILL');
          fs.unlinkSync(pidFile);
        } catch {
          if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
        }
  
        db.query("UPDATE xapp_policies SET is_running = 0 WHERE app_name = ?", [app_name]);
  
        if (!responseSent) {
          await startSimulation();
          res.send({ message: `xApp stopped and simulation restarted`, pid });
          responseSent = true;
        }
      }, 2000);
  
    } catch (err) {
      if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
      res.status(500).send({ error: 'Failed to stop xApp or simulation', detail: err.message });
    }
  });
  

// 刪除
app.post('/delete', (req, res) => {
    const { app_name } = req.body;
    const sourcePath = `${XAPP_DIR}/${app_name}.c`;
    const cmakePath = `${XAPP_DIR}/CMakeLists.txt`;
    const backupPath = `${XAPP_DIR}/CMakeLists.txt.bak`;

    const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    fs.unlink(sourcePath, (err) => {
        if (err) return res.status(500).send({ error: 'Failed to delete xApp file' });

        fs.readFile(cmakePath, 'utf8', (err, data) => {
            if (err) return res.status(500).send({ error: 'Failed to read CMakeLists.txt' });

            fs.copyFileSync(cmakePath, backupPath); // 備份原始 CMakeLists

            const pattern = `# ${escapeRegExp(app_name)}[\\s\\S]*?\\)\\n`;
            const newContent = data.replace(new RegExp(pattern, 'g'), '');

            // ★ 寫回清理後的 CMakeLists
            fs.writeFile(cmakePath, newContent, (err) => {
                if (err) return res.status(500).send({ error: 'Failed to clean CMakeLists.txt' });

                db.query("DELETE FROM xapp_policies WHERE app_name = ?", [app_name], (dbErr) => {
                    if (dbErr) return res.status(500).send({ error: 'DB deletion failed', details: dbErr });
                    res.send({ message: 'xApp deleted successfully', backup: backupPath });
                });
            });
        });
    });
});


// 顯示所有已註冊的 xApp
app.get('/list', (req, res) => {
    db.query("SELECT app_name, policy_type_id, created_at FROM xapp_policies", (err, results) => {
        if (err) return res.status(500).send({ error: 'Failed to fetch xApp list', details: err });
        res.send({ xapps: results });
    });
});


// 讓 A1 Mediator 查到 app_name
app.get('/lookup/:policy_type_id', (req, res) => {
    const { policy_type_id } = req.params;
    db.query("SELECT app_name FROM xapp_policies WHERE policy_type_id = ? AND is_active = 1", [policy_type_id], (err, results) => {
        if (err) return res.status(500).send({ error: 'DB query failed', details: err });
        if (results.length === 0) return res.status(404).send({ error: 'No matching xApp found' });
        res.send({ app_name: results[0].app_name });
    });
});



// 讀取 xapp_config.h
app.get('/read-config', (req, res) => {
  const { app_name } = req.query;
  const configPath = `${XAPP_DIR}/${app_name}/xapp_config.h`;
  if (!fs.existsSync(configPath)) return res.status(404).send({ error: 'xapp_config.h not found' });
  const content = fs.readFileSync(configPath, 'utf8');
  res.send({ content });
});

// 讀取 target_selector.c
app.get('/read-logic', (req, res) => {
  const { app_name } = req.query;
  const logicPath = `${XAPP_DIR}/${app_name}/target_selector.c`;
  if (!fs.existsSync(logicPath)) return res.status(404).send({ error: 'target_selector.c not found' });
  const content = fs.readFileSync(logicPath, 'utf8');
  res.send({ content });
});

// 更新 xapp_config.h
app.post('/update-config', (req, res) => {
  const { app_name, config_text } = req.body;

  if (!app_name || typeof app_name !== 'string') {
    return res.status(400).send({ error: 'app_name 必須是字串' });
  }
  if (typeof config_text !== 'string') {
    return res.status(400).send({ error: 'config_text 必須是 text' });
  }

  const configPath = `${XAPP_DIR}/${app_name}/xapp_config.h`;

  try {
    fs.writeFileSync(configPath, config_text);
    res.send({ message: 'xapp_config.h 已成功覆蓋' });
  } catch (err) {
    console.error('[update-config] 錯誤:', err);
    res.status(500).send({ error: '寫入失敗', detail: err.message });
  }
});

// 修改部分code
app.post('/patch-config', (req, res) => {
  const { app_name, edits } = req.body;
  const configPath = `${XAPP_DIR}/${app_name}/xapp_config.h`;
  if (!fs.existsSync(configPath)) return res.status(404).send({ error: 'not found' });
  let lines = fs.readFileSync(configPath, 'utf8').split('\n');
  for (const {line, new_text} of edits) {
    lines[line - 1] = new_text; // line號從1開始
  }
  fs.writeFileSync(configPath, lines.join('\n'), 'utf8');
  res.send({ message: '部分內容已更新' });
});

// 更新 target_selector.c
app.post('/update-logic', (req, res) => {
  const { app_name, logic_text } = req.body;

  if (!app_name || typeof app_name !== 'string') {
    return res.status(400).send({ error: 'app_name 必須是字串' });
  }
  if (typeof logic_text !== 'string') {
    return res.status(400).send({ error: 'logic_text 必須是 text' });
  }

  const logicPath = `${XAPP_DIR}/${app_name}/target_selector.c`;

  try {
    fs.writeFileSync(logicPath, logic_text);
    res.send({ message: 'target_selector.c 已成功覆蓋' });
  } catch (err) {
    console.error('[update-logic] 錯誤:', err);
    res.status(500).send({ error: '寫入失敗', detail: err.message });
  }
});





// 從 InfluxDB 查詢 Load Balancing KPI：UE 數 + PRB 使用率 + UE 詳細資訊
app.get('/kpi/current_status', async (req, res) => {
  const cellList = ['du-cell-2', 'du-cell-3', 'du-cell-4'];
  const ueCount = 30;
  const ueCellMap = {}; // { cell_id: count }
  const result = {};
  const ueDetails = {}; // { ue_id: { cell, prb, sinr_serving, sinr_quality } }
  const sinrStats = {}; // { cell_id: { total_sinr, bad_sinr_count, ue_count } }

  try {
    for (let ue_id = 1; ue_id <= ueCount; ue_id++) {
      const cellQ = `SELECT last(value) FROM "ue_position_cell_${ue_id}" WHERE time > now() - 10m`;
      const prbQ = `SELECT mean(value) FROM "ue_${ue_id}_rru.prbuseddl" WHERE time > now() - 10m`;
      const sinrServingQ = `SELECT last(value) FROM "ue_${ue_id}_l3 serving sinr" WHERE time > now() - 10m`;

      const [cellRes, prbRes, sinrSRes] = await Promise.all([
        axios.get(`${INFLUX_HOST}/query?db=${INFLUX_DB}&q=${encodeURIComponent(cellQ)}`),
        axios.get(`${INFLUX_HOST}/query?db=${INFLUX_DB}&q=${encodeURIComponent(prbQ)}`),
        axios.get(`${INFLUX_HOST}/query?db=${INFLUX_DB}&q=${encodeURIComponent(sinrServingQ)}`)
      ]);

      const cellVal = cellRes.data?.results?.[0]?.series?.[0]?.values?.[0]?.[1];
      const prbVal = prbRes.data?.results?.[0]?.series?.[0]?.values?.[0]?.[1] ?? null;
      const sinrSVal = sinrSRes.data?.results?.[0]?.series?.[0]?.values?.[0]?.[1] ?? null;

      const parsedCellVal = parseInt(cellVal);
      if (!isNaN(parsedCellVal)) {
        const cell = `du-cell-${parsedCellVal}`;
        ueCellMap[cell] = (ueCellMap[cell] || 0) + 1;

        if (!sinrStats[cell]) sinrStats[cell] = { total_sinr: 0, bad_sinr_count: 0, ue_count: 0 };
        sinrStats[cell].ue_count++;

        const sinrFloat = parseFloat(sinrSVal);
        if (!isNaN(sinrFloat)) {
          sinrStats[cell].total_sinr += sinrFloat;
          if (sinrFloat < 13) sinrStats[cell].bad_sinr_count++;
        }

        let sinr_quality = 'unknown';
        if (!isNaN(sinrFloat)) {
          if (sinrFloat <= 0) sinr_quality = 'no_signal';
          else if (sinrFloat < 13) sinr_quality = 'poor';
          else if (sinrFloat < 20) sinr_quality = 'good';
          else sinr_quality = 'excellent';
        }

        ueDetails[`ue-${ue_id}`] = {
          cell,
          prb: prbVal,
          sinr_serving: sinrSVal,
          sinr_quality
        };
      }
    }

    // 查詢每個 cell 的 PRB 使用率
    for (const cell_id of cellList) {
      const prbQuery = `SELECT mean(value) FROM "${cell_id}_dlprbusage" WHERE time > now() - 10m`;
      const url = `${INFLUX_HOST}/query?db=${INFLUX_DB}&q=${encodeURIComponent(prbQuery)}`;
      const response = await axios.get(url);
      const prb = response.data?.results?.[0]?.series?.[0]?.values?.[0]?.[1] ?? null;

      const sinr_info = sinrStats[cell_id] || { ue_count: 0, total_sinr: 0, bad_sinr_count: 0 };
      const avg_sinr = sinr_info.ue_count > 0 ? sinr_info.total_sinr / sinr_info.ue_count : null;
      const bad_sinr_ratio = sinr_info.ue_count > 0 ? sinr_info.bad_sinr_count / sinr_info.ue_count : null;

      result[cell_id] = {
        ue_count: ueCellMap[cell_id] || 0,
        avg_prb: prb,
        avg_sinr,
        bad_sinr_ratio
      };
    }

    res.send({ cells: result, ue_details: ueDetails });
  } catch (e) {
    res.status(500).send({ error: 'Load balancing query failed', detail: e.message });
  }
});

app.post('/snapshot/save', async (req, res) => {
  try {
    if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${SNAPSHOT_DIR}/snapshot_${timestamp}.json`;
    const latestPath = `${SNAPSHOT_DIR}/latest.json`;
    const prevPath = `${SNAPSHOT_DIR}/prev.json`;

    const axiosRes = await axios.get('http://localhost:9100/kpi/current_status');
    fs.writeFileSync(filename, JSON.stringify(axiosRes.data, null, 2));

    if (fs.existsSync(latestPath)) {
      const lastData = fs.readFileSync(latestPath);
      fs.writeFileSync(prevPath, lastData);
    }
    fs.writeFileSync(latestPath, JSON.stringify(axiosRes.data, null, 2));

    res.send({ message: 'Snapshot saved', file: filename, latest: 'latest.json', previous: fs.existsSync(prevPath) ? 'prev.json' : null });
  } catch (e) {
    res.status(500).send({ error: 'Snapshot save failed', detail: e.message });
  }
});

// === KPI Snapshot Compare (latest vs previous) ===
app.get('/snapshot/compare/latest', (req, res) => {
  const beforePath = `${SNAPSHOT_DIR}/prev.json`;
  const afterPath = `${SNAPSHOT_DIR}/latest.json`;

  if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) {
    return res.status(400).send({ error: 'Missing snapshot files: prev.json or latest.json not found' });
  }

  try {
    const beforeData = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
    const afterData = JSON.parse(fs.readFileSync(afterPath, 'utf8'));
    const delta = {};

    for (const cell of Object.keys(afterData.cells)) {
      const prev = beforeData.cells[cell] || {};
      const curr = afterData.cells[cell] || {};
      delta[cell] = {
        ue_count: curr.ue_count - (prev.ue_count || 0),
        avg_prb_diff: (curr.avg_prb ?? 0) - (prev.avg_prb ?? 0),
        avg_sinr_diff: (curr.avg_sinr ?? 0) - (prev.avg_sinr ?? 0),
        bad_sinr_ratio_diff: (curr.bad_sinr_ratio ?? 0) - (prev.bad_sinr_ratio ?? 0)
      };
    }

    res.send({ message: 'Snapshot comparison (prev vs latest)', delta });
  } catch (e) {
    res.status(500).send({ error: 'Snapshot compare failed', detail: e.message });
  }
});


app.listen(PORT, '0.0.0.0', () => {
    console.log(`API server running on http://0.0.0.0:${PORT}`);
  });
