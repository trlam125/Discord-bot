# Run in PowerShell: .\scripts\register-commands.ps1
# WARNING: This overwrites all application commands scoped to the chosen guild.
param(
    [string]$ApplicationId = "",
    [string]$GuildId = ""
)

$ErrorActionPreference = 'Stop'
if (-not $ApplicationId) { $ApplicationId = Read-Host 'Discord Application ID' }
if (-not $GuildId) { $GuildId = Read-Host 'Discord Server (Guild) ID' }
$SecureToken = Read-Host 'Discord Bot Token (hidden)' -AsSecureString
$Token = [System.Net.NetworkCredential]::new('', $SecureToken).Password 

if ($ApplicationId -notmatch '^\d{17,22}$' -or $GuildId -notmatch '^\d{17,22}$') {
    throw 'Application ID / Guild ID must be numeric Discord snowflakes.'
}
if (-not $Token) { throw 'Missing Discord Bot Token.' }

$commands = @(
    @{
        name = 'steam'; description = 'Tra cuu game Steam theo AppID hoac ten game'
        type = 1; options = @(
            @{ type = 3; name = 'query'; description = 'AppID / ten game / Steam URL'; required = $true; autocomplete = $true; max_length = 100 }
        )
    },
    @{
        name = 'member'; description = 'Xem thong tin thanh vien trong server'
        type = 1; options = @(
            @{ type = 6; name = 'user'; description = 'Thanh vien (de trong = ban)'; required = $false }
        )
    },
    @{
        name = 'avatar'; description = 'Xem avatar Discord chat luong cao'
        type = 1; options = @(
            @{ type = 6; name = 'user'; description = 'Thanh vien (de trong = ban)'; required = $false }
        )
    },
    @{
        name = 'remind'; description = 'Dat lich nhac su kien tu dong'; type = 1
        options = @(
            @{
                type = 1; name = 'create'; description = 'Tao nhac nho'
                options = @(
                    @{ type = 3; name = 'event'; description = 'Ten su kien'; required = $true; max_length = 180 }
                    @{ type = 3; name = 'when'; description = '15m / 2h / 1d / YYYY-MM-DD HH:mm (UTC+7)'; required = $true }
                    @{ type = 7; name = 'channel'; description = 'Kenh gui nhac (mac dinh kenh hien tai)'; required = $false; channel_types = @(0, 5) }
                )
            },
            @{ type = 1; name = 'list'; description = 'Xem nhac nho da tao' },
            @{
                type = 1; name = 'cancel'; description = 'Huy nhac nho'
                options = @(
                    @{ type = 4; name = 'id'; description = 'ID tu lenh /remind list'; required = $true; min_value = 1 }
                )
            }
        )
    },
    @{ name = 'play'; description = 'Phat am thanh HTTPS trong phong thoai'; type = 1; options = @(
        @{ type = 3; name = 'url'; description = 'YouTube/SoundCloud hoac link MP3 cong khai'; required = $true; max_length = 900 }
    ) },
    @{ name = 'pause'; description = 'Tam dung phat nhac'; type = 1 },
    @{ name = 'resume'; description = 'Tiep tuc phat nhac'; type = 1 },
    @{ name = 'skip'; description = 'Chuyen bai dang phat'; type = 1 },
    @{ name = 'queue'; description = 'Danh sach nhac dang cho'; type = 1 },
    @{ name = 'stop'; description = 'Dung nhac va roi phong thoai'; type = 1 },
    @{ name = 'help'; description = 'Huong dan su dung Discord Steam Bot'; type = 1 }
)

$commands += (Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'free-commands.json') | ConvertFrom-Json)
$payload = ConvertTo-Json -InputObject $commands -Depth 12 -Compress
$uri = "https://discord.com/api/v10/applications/$ApplicationId/guilds/$GuildId/commands"
# Discord requires an explicit, valid User-Agent on HTTP API requests.
$userAgent = 'DiscordBot (https://github.com/trlam125/Discord-bot, 1.0.0)'
try {
    $result = Invoke-RestMethod -Method Put -Uri $uri -Headers @{ Authorization = "Bot $Token" } -UserAgent $userAgent -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($payload))
    Write-Host "OK. Registered $(@($result).Count) commands: steam, member, avatar, remind, help, play, pause, resume, skip, queue, stop, free" -ForegroundColor Green
}
catch {
    $errorText = $_.ErrorDetails.Message
    if (-not $errorText) { $errorText = $_.Exception.Message }
    Write-Host "Registration failed: $($_.Exception.Message)" -ForegroundColor Red
    if ($errorText -match '40333') {
        Write-Warning 'Discord/Cloudflare blocked this request (40333). User-Agent is now set; if it persists, check VPN/proxy or try another network. Avoid rapid retries.'
    } elseif ($errorText -match '401|Unauthorized') {
        Write-Warning 'Authentication failed: check the bot token for this Discord application.'
    } elseif ($errorText -match '50001|Missing Access') {
        Write-Warning 'Check that the bot is installed in the target server and applications.commands scope is enabled.'
    }
    if ($_.ErrorDetails.Message) {
        Write-Host "Discord API response: $($_.ErrorDetails.Message)" -ForegroundColor Yellow
    }
    throw
}
finally { $Token = $null }
