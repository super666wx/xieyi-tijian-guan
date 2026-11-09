# 协议体检官 · 容器镜像
# 构建：docker build -t agreement-checkup .
# 运行：docker run -p 8080:8080 \
#         -e ACCESS_PASSWORD=你的口令 \
#         -e MODEL_API_KEY=sk-... \
#         agreement-checkup
# 说明：config.json 不进镜像（见 .dockerignore），首次启动用内置默认值，
#       密钥与端口一律通过环境变量注入；仓库里只保留脱敏的 config.example.json。
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

# 先装依赖，利用构建缓存；devDependencies 里的 tailwind / puppeteer 不装
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# 运行时会往 output/ 写报告
RUN mkdir -p output

EXPOSE 8080

# 健康检查：容器平台据此判断实例是否可用
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
