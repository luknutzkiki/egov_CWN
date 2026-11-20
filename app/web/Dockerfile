# e-Service กลาง · Node.js 20 + Express + SQLite (better-sqlite3)
FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/app.db \
    TZ=Asia/Bangkok

COPY package.json package-lock.json* ./
# better-sqlite3 ใช้ไบนารีสำเร็จรูป ถ้าดาวน์โหลดไม่ได้จะติดตั้งเครื่องมือแล้วคอมไพล์เอง
RUN (npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund) \
 || (apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
     && npm install --omit=dev --no-audit --no-fund --build-from-source \
     && apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*)

COPY src ./src
RUN mkdir -p /app/data

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
