# Builds build/icon.ico for the packaged executable.
#
#   pwsh -File tools\make-appicon.ps1
#
# Unlike the Stream Deck glyphs, an app icon has to read on any background — in
# the taskbar, on the desktop, in Task Manager's Startup tab — so this one carries
# its own tile rather than being white-on-transparent.
#
# The .ico is assembled by hand with PNG-compressed entries. Icon.FromHandle /
# Bitmap.Save(Ico) only ever emit a single low-resolution frame, which looks
# rough anywhere Windows wants a large icon.

Add-Type -AssemblyName System.Drawing

$OutDir = Join-Path $PSScriptRoot '..\build'
$OutIco = Join-Path $OutDir 'icon.ico'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# Names must not collide case-insensitively with any local: PowerShell treats
# $Tile and $tile as one variable, and a GraphicsPath called $tile silently
# replaced this colour.
$TileFill = [System.Drawing.Color]::FromArgb(255,  27,  32,  40)
$Ring  = [System.Drawing.Color]::FromArgb(255,  74, 163, 255)
$White = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)
$Lens  = [System.Drawing.Color]::FromArgb(255,  18,  21,  26)

function New-RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x,           $y,           $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y,           $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d,   0, 90)
  $p.AddArc($x,           $y + $h - $d, $d, $d,  90, 90)
  $p.CloseFigure()
  return $p
}

# Authored in a 256x256 space and scaled down per entry.
function Render([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.ScaleTransform(($size / 256.0), ($size / 256.0))

  $tilePath = New-RoundedPath 8 8 240 240 52
  $g.FillPath((New-Object System.Drawing.SolidBrush $TileFill), $tilePath)
  $pen = New-Object System.Drawing.Pen $Ring, 6
  $g.DrawPath($pen, $tilePath)
  $pen.Dispose(); $tilePath.Dispose()

  $brush = New-Object System.Drawing.SolidBrush $White
  $body = New-RoundedPath 46 86 118 92 22
  $g.FillPath($brush, $body)
  $body.Dispose()

  $horn = New-Object System.Drawing.Drawing2D.GraphicsPath
  $pts = [System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new(172, 116),
    [System.Drawing.PointF]::new(212,  92),
    [System.Drawing.PointF]::new(212, 172),
    [System.Drawing.PointF]::new(172, 148))
  $horn.AddPolygon($pts)
  $g.FillPath($brush, $horn)
  $horn.Dispose()

  $g.FillEllipse((New-Object System.Drawing.SolidBrush $Lens), 82, 108, 48, 48)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $Ring),  94, 120, 24, 24)
  $brush.Dispose()
  $g.Dispose()

  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  # -NoEnumerate: returning a byte[] normally streams it out one byte at a time,
  # and the caller ends up with an Object[] of bytes instead of the array.
  Write-Output -NoEnumerate $ms.ToArray()
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$blobs = New-Object 'System.Collections.Generic.List[byte[]]'
foreach ($s in $sizes) {
  [byte[]]$png = Render $s
  $blobs.Add($png)
  "  {0,4}px -> {1,7:N0} bytes" -f $s, $png.Length
}

$fs = [System.IO.File]::Create($OutIco)
$bw = New-Object System.IO.BinaryWriter $fs

# ICONDIR
$bw.Write([uint16]0)             # reserved
$bw.Write([uint16]1)             # type: icon
$bw.Write([uint16]$sizes.Count)

# ICONDIRENTRY per image, then the payloads
$offset = 6 + (16 * $sizes.Count)
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]
  [byte[]]$blob = $blobs[$i]
  $len = $blob.Length
  # 256 is encoded as 0 in a single byte
  $dim = [byte]($(if ($s -ge 256) { 0 } else { $s }))
  $bw.Write($dim)               # width
  $bw.Write($dim)               # height
  $bw.Write([byte]0)            # palette size
  $bw.Write([byte]0)            # reserved
  $bw.Write([uint16]1)          # colour planes
  $bw.Write([uint16]32)         # bits per pixel
  $bw.Write([uint32]$len)
  $bw.Write([uint32]$offset)
  $offset += $len
}
foreach ($b in $blobs) { $bw.Write([byte[]]$b, 0, ([byte[]]$b).Length) }

$bw.Close(); $fs.Close()

$total = (Get-Item $OutIco).Length
"icon.ico written: $($sizes -join ', ') px, {0:N0} bytes" -f $total
if ($total -lt 2000) { throw "icon.ico looks too small to be valid" }
