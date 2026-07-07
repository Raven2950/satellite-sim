/** 地球物理常数 */
export const EARTH_RADIUS_KM = 6371.0;
export const MU_EARTH = 398600.4418; // km³/s²

/** 地球自转角速度（恒星日，rad/s）——ECI→ECEF，星下点逐圈西漂 */
export const EARTH_ROTATION_RAD_PER_SEC = 7.2921159e-5;

/** 恒星日长度（秒） */
export const SIDEREAL_DAY_SEC = 86164.0905;

/** 轨道参考历元（惯性系轨道相位起点） */
export const ORBIT_EPOCH_ISO = '2024-01-01T00:00:00Z';

/** 仿真时间：仅限制最早时刻，向前播放无上限 */
export const SIMULATION = {
  historyDays: 7,
  unbounded: true,
  /** ICRF 预加载未来天数（长程仿真） */
  icrfPreloadDays: 400,
};

/**
 * 倍速
 * Speed1: 600×；Speed2: 1000×
 */
export const TIME_CONTROL = {
  speed1: 600,
  speed2: 1000,
};

/** 底部时间轴可视窗口（小时），刻度每 5 分钟 */
export const TIMELINE_WINDOW_HOURS = 2;

/** 中国区域边界（用于区域/全球视角） */
export const CHINA_BOUNDS = {
  west: 73,
  south: 18,
  east: 135,
  north: 53,
};

export const DEFAULT_SATELLITES = [
  {
    id: 'sat-1',
    name: '卫星 A',
    orbit: {
      type: 'sun-sync',
      altitudeKm: 500,
      inclinationDeg: 97.4,
      /** 沿晨昏轨道的初始相位（度）；RAAN 由当前太阳方向自动确定 */
      initialPhaseDeg: 0,
    },
    sensor: {
      /** 传感器视场地面幅宽（km） */
      swathWidthKm: 60,
      maxRollDeg: 30,
      rollDeg: 0,
      coverageCellDeg: 0.05,
      /** 条带外缘向外搜索缺口的窄带宽度（m） */
      gapSearchBandM: 20_000,
      /** 沿轨向后搜索长度（m） */
      gapSearchBehindM: 80_000,
    },
    fade: {
      cycleDays: 120,
      freshDays: 1,
    },
    appearance: {
      pointColor: '#00FFFF',
      pointSize: 14,
      /** 3D 模型：本地 glb 超过 maxLocalSizeMb 时自动改用 Ion */
      model: {
        localUri: `${import.meta.env.BASE_URL}models/satellite.glb`,
        maxLocalSizeMb: 12,
        ionAssetIds: [5015623],
        scale: 1,
        /** 屏幕固定尺寸（约 24px 的 1.75 倍） */
        minimumPixelSize: 42,
        maximumPixelSize: 42,
        /** 模型网格轴微调（度），默认已对地 */
        pitchDeg: 0,
        rollDeg: 0,
        yawDeg: 0,
      },
      sensorCone: {
        /** 瞬时高亮 footprint 相对幅宽 */
        footprintScale: 0.55,
      },
    },
  },
];

/** 星下点移动超过此距离（米）时追加条带 */
export const SWATH_SAMPLE_INTERVAL_M = 150;

/** 时间轴跳变超过此秒数时重置条带采样（仅用于 scrub，不影响加速播放） */
export const SWATH_SCRUB_RESET_SEC = 120;
