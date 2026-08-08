# 版本记录（CHANGELOG）

> 版本规则：每次修改代码/样式后必须递增版本号（`<日期><序号>`，如 20260808c），
> 同步更新 4 处：① `server.js` 的 `APP_DEPLOY_VER`；② `index.html` 内联 `VER`；
> ③ 三个资源文件版本戳（app/i18n/style）；④ `app.js` 内 `APP_VERSION`。

## 20260808c — CSS 分摊人员大写化修复（已部署）
- **修复**：`.split-person` 被 `.form-field` 的 `text-transform: uppercase` 继承，导致
  `zyj → ZYJ`，与顶部"同行人"列表显示不一致（汉字不受影响，半中半英最迷惑）。
  在 `.split-person` / `.split-person > span` 显式 `text-transform: none`。
- 涉及：`public/style.css`、`public/style.20260808c.css`（含主文件与版本化文件）。
- 回归清单新增 B11 条目。

## 20260808b — 缓存穿透彻底根治（三管齐下）
- ① 旧版本资源一律 301 → 当前版；② 根路径 302 → `/?v=<当前版>`（no-store）；
  ③ `/api/version` 版本自检自愈。

## 20260808a — 微信缓存强制刷新
- 根路径带版本号跳转 + 资源文件名版本戳 + 内联版本自检。
