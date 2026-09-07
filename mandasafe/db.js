const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'store.json');

function defaultStore() {
    return {
        incidents: [],
        predictionInputs: [],
        accounts: [],
        sessions: [],
        nextIncidentSeq: 1,
        nextInputSeq: 1,
        nextAccountSeq: 1
    };
}

function loadStore() {
    try {
        const raw = fs.readFileSync(DB_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return Object.assign(defaultStore(), parsed);
    } catch (error) {
        const store = defaultStore();
        saveStore(store);
        return store;
    }
}

function saveStore(store) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(store, null, 2), 'utf8');
}

module.exports = { loadStore, saveStore, DB_PATH };
