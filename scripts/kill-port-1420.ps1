$connections = Get-NetTCPConnection -LocalPort 1420 -ErrorAction SilentlyContinue
$processIds = $connections | Select-Object -ExpandProperty OwningProcess -Unique

foreach ($processId in $processIds) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($null -ne $process) {
    Stop-Process -Id $processId -Force
    Write-Host "Killed PID $processId ($($process.ProcessName)) on port 1420"
  }
}

if ($null -eq $processIds -or $processIds.Count -eq 0) {
  Write-Host "Port 1420 is free"
}
