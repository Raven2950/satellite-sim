import * as Cesium from 'cesium';

const { Ion, IonResource } = Cesium;

/** 本地 glb 超过此大小（MB）时改用 Ion 托管模型 */
const DEFAULT_MAX_LOCAL_MB = 12;
/** 小于此字节数视为“没有有效本地模型” */
const MIN_LOCAL_BYTES = 100_000;

/**
 * Ion 上常见的 glTF 模型（按优先级尝试；需有效 Ion Token）
 */
const DEFAULT_ION_ASSET_IDS = [2524683, 265696, 96188];

async function _localHead(uri) {
  try {
    const res = await fetch(uri, { method: 'HEAD' });
    if (!res.ok) return { exists: false, sizeMb: null };
    const bytes = parseInt(res.headers.get('content-length') || '0', 10);
    if (bytes < MIN_LOCAL_BYTES) return { exists: false, sizeMb: null };
    return { exists: true, sizeMb: bytes / (1024 * 1024) };
  } catch {
    return { exists: false, sizeMb: null };
  }
}

async function _tryIonAsset(assetId) {
  const token = Ion.defaultAccessToken;
  if (!token) return null;

  try {
    const res = await fetch(
      `https://api.cesium.com/v1/assets/${assetId}/endpoint?access_token=${encodeURIComponent(token)}`,
    );
    if (!res.ok) {
      throw new Error(`${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    if (!data?.url || !data?.accessToken) {
      throw new Error('Invalid Ion endpoint response');
    }
    return `${data.url}?access_token=${data.accessToken}`;
  } catch (err) {
    console.warn(`Ion asset ${assetId} unavailable:`, err?.message ?? err);
    try {
      const resource = await IonResource.fromAssetId(assetId);
      if (typeof resource.getUrlComponent === 'function') {
        return resource.getUrlComponent(true);
      }
      return String(resource);
    } catch (fallbackErr) {
      console.warn(`Ion asset ${assetId} fallback failed:`, fallbackErr?.message ?? fallbackErr);
      return null;
    }
  }
}

async function _resolveIon(ionAssetIds) {
  for (const assetId of ionAssetIds) {
    const url = await _tryIonAsset(assetId);
    if (url) {
      console.info(`Satellite model: Cesium Ion asset ${assetId}`);
      return url;
    }
  }
  return null;
}

/**
 * 解析卫星 glTF 资源：本地过大或不存在时使用 Ion
 * @returns {Promise<string|null>}
 */
export async function resolveSatelliteModelUri(modelConfig = {}) {
  const {
    localUri = '/models/satellite.glb',
    maxLocalSizeMb = DEFAULT_MAX_LOCAL_MB,
    ionAssetIds = DEFAULT_ION_ASSET_IDS,
    forceIon = false,
  } = modelConfig;

  if (forceIon) {
    return _resolveIon(ionAssetIds);
  }

  const { exists: localExists, sizeMb } = await _localHead(localUri);
  const localTooLarge = localExists && sizeMb !== null && sizeMb > maxLocalSizeMb;

  if (localExists && !localTooLarge && localUri) {
    console.info(
      `Satellite model: local ${localUri}${sizeMb ? ` (${sizeMb.toFixed(1)} MB)` : ''}`,
    );
    return localUri;
  }

  if (localTooLarge) {
    console.info(
      `Local model ${sizeMb.toFixed(1)} MB > ${maxLocalSizeMb} MB, using Cesium Ion`,
    );
  }

  const ionUrl = await _resolveIon(ionAssetIds);
  if (ionUrl) return ionUrl;

  if (localExists && localUri) {
    console.warn('Ion unavailable, using local glb');
    return localUri;
  }

  return null;
}
