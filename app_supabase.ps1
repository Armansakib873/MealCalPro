$Url = "https://bcardtccxcnktkkeszpp.supabase.co/rest/v1/members?select=*&limit=1"
$Headers = @{
    "apikey" = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJjYXJkdGNjeGNua3Rra2VzenBwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ1NzU1NDIsImV4cCI6MjA4MDE1MTU0Mn0.xGxk81ThPGtyQgRCNoOxpvxsnXBUAzgmclrS0ru7g2Q"
    "Authorization" = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJjYXJkdGNjeGNua3Rra2VzenBwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ1NzU1NDIsImV4cCI6MjA4MDE1MTU0Mn0.xGxk81ThPGtyQgRCNoOxpvxsnXBUAzgmclrS0ru7g2Q"
}
Invoke-RestMethod -Uri $Url -Headers $Headers -Method Get | ConvertTo-Json
