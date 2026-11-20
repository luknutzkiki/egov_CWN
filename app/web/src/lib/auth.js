'use strict';
// session และการตรวจสิทธิ์ (CONTRACT §1 · §5 · §6)
//
// รูปแบบ session (express-session · cookie HttpOnly):
//   req.session.user = { kind:'staff'|'citizen', id, username, name, role, dept, citizenId }
//     staff   → id = users.id · username = users.username · dept = 'registry'|'works'|null · citizenId = null
//     citizen → id = citizens.id · citizenId = citizens.id · username = null · role = 'citizen' · dept = null
//   req.session.pendingCitizen = { citizenId, name }   ← ผ่าน OTP แล้วแต่ยังไม่ลงทะเบียน (ใช้ได้เฉพาะ /register)
//   ค่าใน session เป็น snapshot ตอนล็อกอิน → admin เปลี่ยนบทบาทแล้วมีผลกับล็อกอินครั้งถัดไป (CONTRACT §6.5)
//   ห้ามเก็บเลขบัตร/เบอร์ใน session
//
// middleware:
//   requireLogin               ไม่ล็อกอิน → หน้า: redirect /login (pendingCitizen → /register) · API: 401 UNAUTHENTICATED
//   requireRole('officer','head')  + บทบาทไม่ตรง → หน้า: 403 forbidden-msg · API: 403 FORBIDDEN
//   requireCitizen             = requireRole('citizen')

const { sendError } = require('./errors');

const LANDING = {
  citizen: '/citizen',
  officer: '/officer/queue',
  head: '/head/approvals',
  executive: '/dashboard',
  auditor: '/audit',
  admin: '/admin/services',
};

function landingFor(user) {
  if (!user) return '/login';
  return LANDING[user.role] || '/login';
}

// API = path ขึ้นต้น /api/
function isApi(req) {
  return (req.originalUrl || req.url || '').startsWith('/api/');
}

function currentUser(req) {
  return (req.session && req.session.user) || null;
}

// ตั้ง session ใหม่หลังล็อกอิน (regenerate กัน session fixation) · คืน Promise
function login(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.user = {
        kind: user.kind || (user.role === 'citizen' ? 'citizen' : 'staff'),
        id: user.id,
        username: user.username === undefined ? null : user.username,
        name: user.name,
        role: user.role,
        dept: user.dept || null,
        citizenId: user.citizenId === undefined ? (user.role === 'citizen' ? user.id : null) : user.citizenId,
      };
      req.session.save((e) => (e ? reject(e) : resolve(req.session.user)));
    });
  });
}

// session ชั่วคราวของประชาชนที่ยังไม่ลงทะเบียน (ใช้ได้เฉพาะ /register และ API ลงทะเบียน)
function loginPendingCitizen(req, { citizenId, name }) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.pendingCitizen = { citizenId, name };
      req.session.save((e) => (e ? reject(e) : resolve(req.session.pendingCitizen)));
    });
  });
}

function logout(req) {
  return new Promise((resolve) => {
    if (!req.session) return resolve();
    req.session.destroy(() => resolve());
  });
}

function forbiddenPage(req, res) {
  // โหลดตอนเรียก เพื่อเลี่ยง require วนกับ views/layout
  return require('../views/layout').renderForbidden(req, res);
}

function unauthenticated(req, res) {
  if (isApi(req)) return sendError(res, 'UNAUTHENTICATED');
  if (req.session && req.session.pendingCitizen) return res.redirect('/register');
  return res.redirect('/login');
}

function requireLogin(req, res, next) {
  if (!currentUser(req)) return unauthenticated(req, res);
  req.user = currentUser(req);
  return next();
}

function requireRole(...roles) {
  const allowed = new Set(roles.flat());
  return function roleGuard(req, res, next) {
    const user = currentUser(req);
    if (!user) return unauthenticated(req, res);
    req.user = user;
    if (!allowed.has(user.role)) {
      if (isApi(req)) return sendError(res, 'FORBIDDEN');
      return forbiddenPage(req, res);
    }
    return next();
  };
}

const requireCitizen = requireRole('citizen');
const requireStaff = requireRole('officer', 'head', 'executive', 'auditor', 'admin');

function hasRole(req, ...roles) {
  const user = currentUser(req);
  return !!user && roles.flat().includes(user.role);
}

module.exports = {
  LANDING, landingFor, isApi, currentUser, login, loginPendingCitizen, logout,
  requireLogin, requireRole, requireCitizen, requireStaff, hasRole,
};
