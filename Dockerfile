# 旅游攻略协作应用 —— 零依赖 Node 服务镜像
# 适用：Render / Railway / Fly.io / 任意支持 Docker 的 Node 托管
FROM node:20-alpine

WORKDIR /app

# 仅复制运行所需文件（无需 npm install，应用零依赖）
COPY package.json ./
COPY server.js ./
COPY data ./data
COPY public ./public

# 持久化数据目录（挂盘时通过环境变量 DATA_DIR 覆盖此路径）
ENV PORT=3000
ENV DATA_DIR=/app/data

EXPOSE 3000
CMD ["node", "server.js"]
