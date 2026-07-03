# 卫星仿真 (Satellite Sim)

晨昏轨道卫星扫描动画：默认中国视角、Wayfinder 风格时间控制、30 天条带褪色。

## 在线演示

部署成功后访问：**https://raven2950.github.io/satellite-sim/**

## 快速开始（本地开发）

```bash
cp .env.example .env   # 填入 VITE_CESIUM_ION_TOKEN
npm install
npm run dev
# 浏览器打开 http://localhost:5173/satellite-sim/
```

## 时间控制（底部）

| 按钮 | 作用 |
|------|------|
| **LIVE** | 回到真实 UTC，实时播放（1×） |
| **▶ / ⏸** | 播放 / 暂停 |
| **1×** | 倍速 1（600×） |
| **2×** | 倍速 2（1000×） |

## 核心设计

- **轨道**：500 km 太阳同步圆轨道，周期 ~94.5 分钟
- **地球**：贴图固定；星下点逐圈西漂（ECI→ECEF）
- **条带**：60 km 宽，白色 → 灰色 → 消失（30 天）

## 修改参数

编辑 `src/config/satellite.js`

## GitHub Pages 部署

仓库已含 `.github/workflows/deploy-pages.yml`。在 GitHub 仓库 Settings → Pages → Source 选 **GitHub Actions**，并在 Secrets 中配置 `VITE_CESIUM_ION_TOKEN` 后，push 到 `main` 即自动部署。
