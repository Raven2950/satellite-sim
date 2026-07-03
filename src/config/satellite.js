/** 地球物理常数 */
export const EARTH_RADIUS_KM = 6371.0;
export const MU_EARTH = 398600.4418; // km³/s²

/** 地球自转角速度（恒星日，rad/s）——ECI→ECEF，星下点逐圈西漂 */
export const EARTH_ROTATION_RAD_PER_SEC = 7.2921159e-5;

/** 恒星日长度（秒） */
export const SIDEREAL_DAY_SEC = 86164.0905;

/** 轨道参考历元（惯性系轨道相位起点） */
export const ORBIT_EPOCH_ISO = '2024-01-01T00:00:00Z';

/** 时间轴可视窗口：当前时刻 ±30 天 */
export const SIMULATION = {
  historyDays: 30,
  futureDays: 30,
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
      raanDeg: 280,
      initialPhaseDeg: 145,
    },
    sensor: {
      swathWidthKm: 60,
      maxRollDeg: 30,
      rollDeg: 0,
    },
    fade: {
      cycleDays: 30,
      freshDays: 1,
    },
    appearance: {
      pointColor: '#00FFFF',
      pointSize: 14,
      /** 3D 模型：本地 glb 超过 maxLocalSizeMb 时自动改用 Ion */
      model: {
        localUri: '/models/satellite.glb',
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
