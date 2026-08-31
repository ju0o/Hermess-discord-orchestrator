$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist\index.js'))) {
  throw 'Run npm install and npm run build first.'
}
npm start
exit $LASTEXITCODE
