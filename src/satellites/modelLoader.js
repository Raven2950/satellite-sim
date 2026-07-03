import * as Cesium from 'cesium';

const { Ion, IonResource } = Cesium;

/** 本地 glb 超过此大小（MB）时改用 Ion 托管模型 */
const DEFAULT_MAX_LOCAL_MB = 12;

/**
 * Ion 上常见的 glTF 模型（按优先级尝试；需有效 Ion Token）
 * 2524683 / 265696 为社区常用的卫星类资产，96188 为 Cesium Air 兜底
 */
const DEFAULT_ION_ASSET_IDS = [2524683, 265696, 96188];

async function _localHead(uri) {
  try {
    const res = await fetch(uri, { method: 'HEAD' });
    if (!res.ok) return { exists: false, sizeMb: null };
    const bytes = parseInt(res.headers.get('content-length') || '0', 10);
    return {
      exists: true,
      sizeMb: bytes > 0 ? bytes / (1024 * 1024) : 0,
    };
  } catch {
    return { exists: false, sizeMb: null };
  }
}

async function _tryIonAsset(assetId) {
  if (!Ion.defaultAccessToken) return null;
  try {
    return await IonResource.fromAssetId(assetId);
  } catch (err) {
    console.warn(`Ion asset ${assetId} unavailable:`, err?.message ?? err);
    return null;
  }
}

async function _tryLocalGltf(uri) {
  return uri;
}

/**
 * 解析卫星 glTF 资源：本地过大或加载失败时回退 Ion
 * @returns {Promise<string|import('cesium').Resource|null>}
 */
export async function resolveSatelliteModelUri(modelConfig = {}) {
  const {
    localUri = '/models/satellite.glb',
    maxLocalSizeMb = DEFAULT_MAX_LOCAL_MB,
    ionAssetIds = DEFAULT_ION_ASSET_IDS,
    forceIon = false,
  } = modelConfig;

  const { exists: localExists, sizeMb } = await _localHead(localUri);
  const localTooLarge = localExists && sizeMb !== null && sizeMb > maxLocalSizeMb;

  if (!forceIon && localExists && !localTooLarge && localUri) {
    console.info(
      `Satellite model: local ${localUri}${sizeMb ? ` (${sizeMb.toFixed(1)} MB)` : ''}`,
    );
    return localUri;
  }

  if (localTooLarge) {
    console.info(
      `Local model ${sizeMb.toFixed(1)} MB > ${maxLocalSizeMb} MB, using Cesium Ion fallback`,
    );
  }

  for (const assetId of ionAssetIds) {
    const resource = await _tryIonAsset(assetId);
    if (resource) {
      console.info(`Satellite model: Cesium Ion asset ${assetId}`);
      return resource;
    }
  }

  if (localUri) {
    console.warn('Ion models unavailable, falling back to local glb');
    return _tryLocalGltf(localUri);
  }

  return null;
}
