# Renders the Stream Deck plugin's icon set with System.Drawing.
#
#   pwsh -File streamdeck\tools\make-icons.ps1
#
# Deliberately not Electron: capturePage() and offscreen 'paint' both return
# empty images for a window that is never composited, and toPNG() then yields a
# zero-byte buffer without throwing. GDI+ has no such dependency.
#
# All artwork is authored in a 72x72 space and scaled to the requested size.
# Stream Deck resolves "imgs/foo" to foo.png (1x) and foo@2x.png (2x).
#
# Each dedicated-state action needs an "on" and an "off" variant: the button is
# lit when the overlay is CURRENTLY in that state, dim when it isn't.

Add-Type -AssemblyName System.Drawing

$OutRoot = Join-Path $PSScriptRoot '..\com.eddy.webcamoverlay.sdPlugin'

$White     = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)
$Accent    = [System.Drawing.Color]::FromArgb(255,  74, 163, 255)
$Red       = [System.Drawing.Color]::FromArgb(255, 255,  95,  86)
$FrameOn   = [System.Drawing.Color]::FromArgb(255, 139, 147, 160)
$Dark      = [System.Drawing.Color]::FromArgb(255,  18,  21,  26)

# "off" palette - same shapes, clearly unlit
$DimGlyph  = [System.Drawing.Color]::FromArgb(255,  77,  83,  92)
$DimRed    = [System.Drawing.Color]::FromArgb(255, 122,  74,  70)
$FrameOff  = [System.Drawing.Color]::FromArgb(255,  63,  68,  76)

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

function Draw-Camera($g, [System.Drawing.Color]$c) {
  $brush = New-Object System.Drawing.SolidBrush $c
  $body = New-RoundedPath 10 20 38 30 7
  $g.FillPath($brush, $body)
  $body.Dispose()

  # lens horn. The array MUST be cast: without it PowerShell binds the
  # single-Point overload of AddPolygon and throws.
  $horn = New-Object System.Drawing.Drawing2D.GraphicsPath
  $pts = [System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new(52, 30),
    [System.Drawing.PointF]::new(64, 23),
    [System.Drawing.PointF]::new(64, 49),
    [System.Drawing.PointF]::new(52, 42))
  $horn.AddPolygon($pts)
  $g.FillPath($brush, $horn)
  $horn.Dispose()

  $g.FillEllipse((New-Object System.Drawing.SolidBrush $Dark), 21, 27, 16, 16)
  $g.FillEllipse($brush, 25, 31, 8, 8)
  $brush.Dispose()
}

function Draw-Slash($g, [System.Drawing.Color]$c) {
  $pen = New-Object System.Drawing.Pen $c, 7
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
  $g.DrawLine($pen, 13, 12, 61, 60)
  $pen.Dispose()
}

function Draw-Mode($g, [bool]$max, [System.Drawing.Color]$frame, [System.Drawing.Color]$fill) {
  $pen = New-Object System.Drawing.Pen $frame, 4
  $outline = New-RoundedPath 6 12 60 44 5
  $g.DrawPath($pen, $outline)
  $outline.Dispose(); $pen.Dispose()

  $brush = New-Object System.Drawing.SolidBrush $fill
  $inner = if ($max) { New-RoundedPath 12 18 48 32 3 } else { New-RoundedPath 38 34 22 16 3 }
  $g.FillPath($brush, $inner)
  $inner.Dispose(); $brush.Dispose()
}

function Draw-Opacity($g) {
  $pen = New-Object System.Drawing.Pen $White, 4
  $g.DrawEllipse($pen, 12, 12, 48, 48)
  $pen.Dispose()
  $brush = New-Object System.Drawing.SolidBrush $White
  $g.FillPie($brush, 12, 12, 48, 48, -90, 180)
  $brush.Dispose()
}

function Draw-Radius($g) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddLine(20, 58, 20, 34)
  $path.AddArc(20, 14, 40, 40, 180, 90)
  $path.AddLine(40, 14, 58, 14)
  $pen = New-Object System.Drawing.Pen $White, 6
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
  $g.DrawPath($pen, $path)
  $pen.Dispose(); $path.Dispose()

  $brush = New-Object System.Drawing.SolidBrush $Accent
  $g.FillEllipse($brush, 16, 54, 8, 8)
  $g.FillEllipse($brush, 54, 10, 8, 8)
  $brush.Dispose()
}

function Save-Icon([string]$rel, [int]$size, [scriptblock]$draw) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::Transparent)
  $k = $size / 72.0
  $g.ScaleTransform($k, $k)
  & $draw $g
  $g.Dispose()

  # The extension matters: Bitmap.Save writes PNG bytes regardless of the file
  # name, so omitting it produces valid images Stream Deck will never find.
  $file = Join-Path $OutRoot (($rel -replace '/', '\') + '.png')
  New-Item -ItemType Directory -Force -Path (Split-Path $file) | Out-Null
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()

  $len = (Get-Item $file).Length
  if ($len -lt 100) { throw "empty render: $file ($len bytes)" }
  "{0,4}px {1,6}B  {2}.png" -f $size, $len, $rel
}

$icons = @(
  @{ rel = 'imgs/plugin/icon';     size = 72; draw = { param($g) Draw-Camera $g $White } },
  @{ rel = 'imgs/plugin/category'; size = 28; draw = { param($g) Draw-Camera $g $White } },

  # Show - lit while the overlay is visible
  @{ rel = 'imgs/actions/show/icon'; size = 20; draw = { param($g) Draw-Camera $g $White } },
  @{ rel = 'imgs/actions/show/on';   size = 72; draw = { param($g) Draw-Camera $g $White } },
  @{ rel = 'imgs/actions/show/off';  size = 72; draw = { param($g) Draw-Camera $g $DimGlyph } },

  # Hide - lit while the overlay is hidden
  @{ rel = 'imgs/actions/hide/icon'; size = 20; draw = { param($g) Draw-Camera $g $White;    Draw-Slash $g $Red } },
  @{ rel = 'imgs/actions/hide/on';   size = 72; draw = { param($g) Draw-Camera $g $White;    Draw-Slash $g $Red } },
  @{ rel = 'imgs/actions/hide/off';  size = 72; draw = { param($g) Draw-Camera $g $DimGlyph; Draw-Slash $g $DimRed } },

  # Maximize - lit while maximized
  @{ rel = 'imgs/actions/maximize/icon'; size = 20; draw = { param($g) Draw-Mode $g $true $FrameOn  $Accent } },
  @{ rel = 'imgs/actions/maximize/on';   size = 72; draw = { param($g) Draw-Mode $g $true $FrameOn  $Accent } },
  @{ rel = 'imgs/actions/maximize/off';  size = 72; draw = { param($g) Draw-Mode $g $true $FrameOff $DimGlyph } },

  # Window mode - lit while windowed
  @{ rel = 'imgs/actions/window/icon'; size = 20; draw = { param($g) Draw-Mode $g $false $FrameOn  $Accent } },
  @{ rel = 'imgs/actions/window/on';   size = 72; draw = { param($g) Draw-Mode $g $false $FrameOn  $Accent } },
  @{ rel = 'imgs/actions/window/off';  size = 72; draw = { param($g) Draw-Mode $g $false $FrameOff $DimGlyph } },

  @{ rel = 'imgs/actions/opacity/icon';    size = 20; draw = { param($g) Draw-Opacity $g } },
  @{ rel = 'imgs/actions/opacity/key';     size = 72; draw = { param($g) Draw-Opacity $g } },
  @{ rel = 'imgs/actions/opacity/encoder'; size = 72; draw = { param($g) Draw-Opacity $g } },

  @{ rel = 'imgs/actions/radius/icon';     size = 20; draw = { param($g) Draw-Radius $g } },
  @{ rel = 'imgs/actions/radius/key';      size = 72; draw = { param($g) Draw-Radius $g } },
  @{ rel = 'imgs/actions/radius/encoder';  size = 72; draw = { param($g) Draw-Radius $g } }
)

$count = 0
foreach ($i in $icons) {
  Save-Icon $i.rel           $i.size        $i.draw
  Save-Icon "$($i.rel)@2x"  ($i.size * 2)   $i.draw
  $count += 2
}
""
"$count PNGs written."
