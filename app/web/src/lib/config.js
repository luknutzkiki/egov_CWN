'use strict';
// ค่าจาก env ที่ใช้ร่วมกัน (docker-compose.yml ตั้งให้)
const { TEST_MODE } = require('./clock');
const { DB_PATH } = require('../db');

const PORT = Number(process.env.PORT) || 3000;
// ใช้สร้าง URL ภายนอก เช่น `doc-qr` data-url = `${BASE_URL}/verify/<รหัส>` (ไม่มี / ท้าย)
const BASE_URL = String(process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

module.exports = { TEST_MODE, PORT, BASE_URL, DB_PATH };
