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
    simTime: 1000,
    KPM_E2functionID: 2,
    RC_E2functionID: 3,
    N_Ues: 30,
    N_MmWaveEnbNodes: 5,
    CenterFrequency: 3.5e9,
    Bandwidth: 20e6,
    IntersideDistanceUEs: 500,
    IntersideDistanceCells: 600,
    scenario: "scratch/scenario-zero-with_parallel_loging.cc",
    flags: "true"
  }, {
    headers: { 'Content-Type': 'application/json' }
  });
}

// 建立 xApp
app.post('/create', (req, res) => {
    const { app_name, policy_id } = req.body;
    if (!/^[a-zA-Z0-9_-]+$/.test(app_name)) {
        return res.status(400).send({ error: 'Invalid app_name' });
    }

    const filePath = `${XAPP_DIR}/${app_name}.c`;
    const content = req.body.content || '// TODO: your xApp code here';

    fs.writeFile(filePath, content, (err) => {
        if (err) return res.status(500).send({ error: 'Failed to create xApp file' });

        // 寫入 MySQL
        db.query("INSERT INTO xapp_policies (app_name, policy_type_id) VALUES (?, ?)",
            [app_name, policy_id|| ''],
            (dbErr) => {
                if (dbErr) return res.status(500).send({ error: 'DB insert failed', details: dbErr });
                res.send({ message: 'xApp created and registered successfully' });
            });
    });
});

// 更新 CMakeLists.txt（防重複）
app.post('/update-cmake', (req, res) => {
  const { app_name } = req.body;
  const cmakePath = `${XAPP_DIR}/CMakeLists.txt`;

  fs.readFile(cmakePath, 'utf-8', (err, data) => {
      if (err) return res.status(500).send({ error: 'Failed to read CMakeLists.txt' });
      if (data.includes(`add_executable(${app_name}`)) {
          return res.status(400).send({ error: 'CMakeLists already contains this app' });
      }

      // ⚠️ 自動加入 CivetWeb + SSL 編譯設定
      const block = `
# ${app_name}
add_executable(${app_name}
  ${app_name}.c
  civetweb/src/civetweb.c
  ../../../../src/util/alg_ds/alg/defer.c
)

# 啟用 CivetWeb SSL 支援
target_compile_definitions(${app_name} PRIVATE USE_SSL NO_SSL_DL OPENSSL_API_1_1)

target_link_libraries(${app_name}
  PUBLIC
  e42_xapp
  pthread
  sctp
  dl
  CURL::libcurl
  \${OPENSSL_LIBRARIES}
)
`;

      fs.appendFile(cmakePath, block, (err) => {
          if (err) return res.status(500).send({ error: 'Failed to update CMakeLists.txt' });
          res.send({ message: 'CMakeLists.txt updated successfully' });
      });
  });
});


// 編譯
app.post('/compile', (req, res) => {
    const command = `cd ${BUILD_DIR} && sudo cmake .. -DE2AP_VERSION=E2AP_V1 -DKPM_VERSION=KPM_V3_00 && sudo make -j8`;
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



app.listen(PORT, '0.0.0.0', () => {
    console.log(`API server running on http://0.0.0.0:${PORT}`);
  });
