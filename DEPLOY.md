# 部署指南（恢复多人协作）

本应用是**零依赖 Node 服务 + 单文件 `data/rooms.json`** 做协作存储。多人打开同一房间号
（如 `https://你的域名/#macau-2026`）即可协作：增删改、合并审阅、自动导航都可用；
前端每 10 秒静默拉取他人改动。

> 注意：CloudStudio 只能托管静态文件、跑不了 Node 后端，所以无法用它恢复协作。
> 需要把整个项目（server.js + public/）部署到「能跑 Node + 可写磁盘」的托管平台。

## 方式 A：Render（推荐，最快，免费档即可）
1. 把本项目推到 GitHub 仓库。
2. 打开 https://render.com → New → Web Service → 关联仓库。
3. 选择 **Docker** 环境（已含 `Dockerfile`），或选 Node 环境、Build Command 留空、Start Command `node server.js`。
4. 免费档即可；如需数据永久保留，在控制台挂载一块 Disk 到 `/app/data`。
5. 部署完成后，访问 `https://xxx.onrender.com/#macau-2026`。

## 方式 B：Railway / Fly.io
- Railway：关联仓库 → 选 Node → `node server.js` 即可，自带可写存储。
- Fly.io：`fly launch`（用仓库里的 `Dockerfile`）→ `fly deploy`。

## 方式 C：WorkBuddy CloudBase（自带生态，需改存储层）
CloudBase 提供「静态托管 + 云函数 + 文档数据库」，属于 WorkBuddy 生态。
但需：① 在 WorkBuddy 连接 CloudBase 连接器；② 把 `server.js` 的存储从 `fs` 改为
CloudBase 文档库。改动较大，适合希望完全留在腾讯云体系的场景。需要的话让我来改。

## 本地运行（对照 / 备份）
```
node server.js        # 默认 http://localhost:3000
```
`data/rooms.json` 会被 `.gitignore` 忽略，首次启动由 `data/seed.json` 自动生成演示房间。
