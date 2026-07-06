# 卫星仿真 (Satellite Sim)

晨昏轨道卫星扫描动画：默认中国视角、Wayfinder 风格时间控制、30 天条带褪色。

## 在线演示

**https://raven2950.github.io/satellite-sim/**

## 时间控制（底部）

| 按钮 | 作用 |
|------|------|
| **LIVE** | 回到真实 UTC，实时播放（1×） |
| **▶ / ⏸** | 播放 / 暂停 |
| **1×** | 倍速 1（600×） |
| **2×** | 倍速 2（1000×） |

## 修改参数

编辑 `src/config/satellite.js`

## GitHub Pages 部署

仓库已含 `.github/workflows/deploy-pages.yml`。在 GitHub 仓库 Settings → Pages → Source 选 **GitHub Actions**，并在 Secrets 中配置 `VITE_CESIUM_ION_TOKEN` 后，push 到 `main` 即自动部署。
