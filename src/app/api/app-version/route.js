export async function GET(request) {
  const latestVersionCode = parseInt(process.env.LATEST_APP_VERSION_CODE || '2', 10);
  const latestVersionName = process.env.LATEST_APP_VERSION_NAME || '1.0.1';

  let defaultUrl = '/ethiopay.apk';
  const host = request?.headers?.get('host');
  if (host) {
    const proto = host.includes('localhost') ? 'http' : 'https';
    defaultUrl = `${proto}://${host}/ethiopay.apk`;
  }

  const downloadUrl = process.env.APP_DOWNLOAD_URL || defaultUrl;
  const releaseNotes =
    process.env.APP_RELEASE_NOTES ||
    'Redesigned UI matching mockups, instant offline reconnect sync & Telegram supergroup auto-healing.';
  const minSupportedVersionCode = parseInt(process.env.MIN_SUPPORTED_VERSION_CODE || '1', 10);

  return Response.json({
    latestVersionCode,
    latestVersionName,
    downloadUrl,
    releaseNotes,
    minSupportedVersionCode,
  });
}

