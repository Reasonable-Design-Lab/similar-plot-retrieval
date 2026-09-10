param(
  [int]$Port = 4173
)

Write-Host "Serving the map at http://localhost:$Port"
Write-Host "Press Ctrl+C to stop."
python -m http.server $Port --directory dist
