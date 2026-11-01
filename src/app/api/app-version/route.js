export async function GET() {
  const latestVersionCode = parseInt(process.env.LATEST_APP_VERSION_CODE || '2', 10);
  const latestVersionName = process.env.LATEST_APP_VERSION_NAME || '1.0.1';
  const downloadUrl =
    process.env.APP_DOWNLOAD_URL ||
    'https://github.com/ethiopay/releases/releases/latest/download/app-release.apk';
  const releaseNotes =
    process.env.APP_RELEASE_NOTES ||
    'Fixed M-Pesa & CBE interbank payment capture, added offline system alert overlay, and improved Settings UI.';
  const minSupportedVersionCode = parseInt(process.env.MIN_SUPPORTED_VERSION_CODE || '1', 10);

  return Response.json({
    latestVersionCode,
    latestVersionName,
    downloadUrl,
    releaseNotes,
    minSupportedVersionCode,
  });
}

