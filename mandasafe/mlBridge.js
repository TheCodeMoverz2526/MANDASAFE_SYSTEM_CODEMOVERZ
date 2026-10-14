// All of MandaSafe's actual model training/inference (the severity Random Forest, the KDE
// hotspot surface) lives in Python now -- see ml/. This just hands data to a script over
// stdin/stdout and parses the JSON it prints back.
const { spawnSync } = require('child_process');
const path = require('path');

const PYTHON = process.env.MANDASAFE_PYTHON_BIN || 'python';

function runPython(scriptName, payload) {
    const result = spawnSync(PYTHON, [path.join(__dirname, 'ml', scriptName)], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 64
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${scriptName} exited with code ${result.status}: ${result.stderr}`);
    }
    return JSON.parse(result.stdout);
}

module.exports = { runPython };
