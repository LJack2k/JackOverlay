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

$OutRoot = Join-Path $PSScriptRoot '..\com.ljack2k.webcamoverlay.sdPlugin'

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

# Status badges, applied over any action's own image via setImage so a key can
# report a problem without commandeering its title.
function Draw-Status($g, [string]$kind) {
  $amber = [System.Drawing.Color]::FromArgb(255, 240, 173,  78)
  if ($kind -eq 'offline') {
    # Warning triangle with an exclamation: the overlay app isn't reachable.
    $tri = New-Object System.Drawing.Drawing2D.GraphicsPath
    $pts = [System.Drawing.PointF[]]@(
      [System.Drawing.PointF]::new(36, 12),
      [System.Drawing.PointF]::new(64, 58),
      [System.Drawing.PointF]::new(8,  58))
    $tri.AddPolygon($pts)
    $pen = New-Object System.Drawing.Pen $amber, 6
    $pen.LineJoin = 'Round'
    $g.DrawPath($pen, $tri)
    $pen.Dispose(); $tri.Dispose()

    $bar = New-Object System.Drawing.SolidBrush $amber
    $g.FillRectangle($bar, 33, 28, 6, 14)
    $g.FillEllipse($bar, 33, 46, 6, 6)
    $bar.Dispose()
  } else {
    # Frame with a cross: the overlay this key points at no longer exists.
    $pen = New-Object System.Drawing.Pen $FrameOff, 4
    $outline = New-RoundedPath 6 12 60 44 5
    $g.DrawPath($pen, $outline)
    $outline.Dispose(); $pen.Dispose()

    $x = New-Object System.Drawing.Pen $Red, 6
    $x.StartCap = 'Round'; $x.EndCap = 'Round'
    $g.DrawLine($x, 22, 22, 50, 46)
    $g.DrawLine($x, 50, 22, 22, 46)
    $x.Dispose()
  }
}

function Fill-Triangle($g, $brush, $points) {
  # The array MUST be cast, or PowerShell binds the single-Point overload of
  # AddPolygon and throws.
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $pts = [System.Drawing.PointF[]]@($points | ForEach-Object {
    [System.Drawing.PointF]::new($_[0], $_[1])
  })
  $path.AddPolygon($pts)
  $g.FillPath($brush, $path)
  $path.Dispose()
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

# Screen outline filled edge to edge.
function Draw-Maximize($g, [System.Drawing.Color]$frame, [System.Drawing.Color]$fill) {
  $pen = New-Object System.Drawing.Pen $frame, 4
  $outline = New-RoundedPath 6 12 60 44 5
  $g.DrawPath($pen, $outline)
  $outline.Dispose(); $pen.Dispose()

  $brush = New-Object System.Drawing.SolidBrush $fill
  $inner = New-RoundedPath 12 18 48 32 3
  $g.FillPath($brush, $inner)
  $inner.Dispose(); $brush.Dispose()
}

# The familiar "restore down" glyph: two offset windows, front one over the back.
# Deliberately NOT a screen outline with a small box inside it — that reads as a
# corner preset, which is what this used to be confused with.
function Draw-Restore($g, [System.Drawing.Color]$frame, [System.Drawing.Color]$fill) {
  $pen = New-Object System.Drawing.Pen $frame, 4
  $back = New-RoundedPath 32 12 28 28 4
  $g.DrawPath($pen, $back)
  $back.Dispose(); $pen.Dispose()

  # Knock a gap out of the back window so the two read as separate panes. The key
  # background is dark, so painting $Dark here is the same trick as the camera lens.
  $gap = New-RoundedPath 12 24 36 36 6
  $g.FillPath((New-Object System.Drawing.SolidBrush $Dark), $gap)
  $gap.Dispose()

  $brush = New-Object System.Drawing.SolidBrush $fill
  $front = New-RoundedPath 16 28 28 28 4
  $g.FillPath($brush, $front)
  $front.Dispose(); $brush.Dispose()
}

# Screen outline with a small window parked in one corner of it.
function Draw-Corner($g, [string]$vert, [string]$horiz,
                     [System.Drawing.Color]$frame, [System.Drawing.Color]$fill) {
  $pen = New-Object System.Drawing.Pen $frame, 4
  $outline = New-RoundedPath 6 12 60 44 5
  $g.DrawPath($pen, $outline)
  $outline.Dispose(); $pen.Dispose()

  $x = if ($horiz -eq 'left') { 12 } else { 40 }
  $y = if ($vert  -eq 'top')  { 18 } else { 36 }

  $brush = New-Object System.Drawing.SolidBrush $fill
  $box = New-RoundedPath $x $y 20 14 3
  $g.FillPath($brush, $box)
  $box.Dispose(); $brush.Dispose()
}

# Screen outline with a double-headed arrow across it: pan the image inside the frame.
function Draw-Pan($g, [bool]$horizontal) {
  $pen = New-Object System.Drawing.Pen $FrameOn, 4
  $outline = New-RoundedPath 6 12 60 44 5
  $g.DrawPath($pen, $outline)
  $outline.Dispose(); $pen.Dispose()

  # Hand-drawn rather than AdjustableArrowCap: the frame leaves only ~30px for the
  # vertical arrow, and cap-based heads at that length consume the whole shaft and
  # render as a diamond.
  $brush = New-Object System.Drawing.SolidBrush $White
  if ($horizontal) {
    $g.FillRectangle($brush, 24, 31, 24, 6)
    Fill-Triangle $g $brush @(@(15,34), @(26,27), @(26,41))
    Fill-Triangle $g $brush @(@(57,34), @(46,27), @(46,41))
  } else {
    $g.FillRectangle($brush, 33, 26, 6, 16)
    Fill-Triangle $g $brush @(@(36,15), @(29,26), @(43,26))
    Fill-Triangle $g $brush @(@(36,53), @(29,42), @(43,42))
  }
  $brush.Dispose()
}

# Magnifier with a plus. Deliberately not another disc or frame — opacity is
# already a circle and the mode/corner glyphs are already frames.
function Draw-Zoom($g) {
  $pen = New-Object System.Drawing.Pen $White, 5
  $g.DrawEllipse($pen, 16, 12, 32, 32)
  $pen.Dispose()

  $handle = New-Object System.Drawing.Pen $White, 7
  $handle.StartCap = 'Round'; $handle.EndCap = 'Round'
  $g.DrawLine($handle, 44, 40, 56, 52)
  $handle.Dispose()

  $plus = New-Object System.Drawing.Pen $Accent, 4
  $plus.StartCap = 'Round'; $plus.EndCap = 'Round'
  $g.DrawLine($plus, 25, 28, 39, 28)
  $g.DrawLine($plus, 32, 21, 32, 35)
  $plus.Dispose()
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
  @{ rel = 'imgs/actions/maximize/icon'; size = 20; draw = { param($g) Draw-Maximize $g $FrameOn  $Accent } },
  @{ rel = 'imgs/actions/maximize/on';   size = 72; draw = { param($g) Draw-Maximize $g $FrameOn  $Accent } },
  @{ rel = 'imgs/actions/maximize/off';  size = 72; draw = { param($g) Draw-Maximize $g $FrameOff $DimGlyph } },

  # Window mode - lit while windowed
  @{ rel = 'imgs/actions/window/icon'; size = 20; draw = { param($g) Draw-Restore $g $FrameOn  $Accent } },
  @{ rel = 'imgs/actions/window/on';   size = 72; draw = { param($g) Draw-Restore $g $FrameOn  $Accent } },
  @{ rel = 'imgs/actions/window/off';  size = 72; draw = { param($g) Draw-Restore $g $FrameOff $DimGlyph } },

  # Screen-corner presets - lit while the overlay is parked in that corner
  @{ rel = 'imgs/actions/topleft/icon';     size = 20; draw = { param($g) Draw-Corner $g 'top' 'left' $FrameOn  $Accent } },
  @{ rel = 'imgs/actions/topleft/on';       size = 72; draw = { param($g) Draw-Corner $g 'top' 'left' $FrameOn  $Accent } },
  @{ rel = 'imgs/actions/topleft/off';      size = 72; draw = { param($g) Draw-Corner $g 'top' 'left' $FrameOff $DimGlyph } },

  @{ rel = 'imgs/actions/topright/icon';    size = 20; draw = { param($g) Draw-Corner $g 'top' 'right' $FrameOn  $Accent } },
  @{ rel = 'imgs/actions/topright/on';      size = 72; draw = { param($g) Draw-Corner $g 'top' 'right' $FrameOn  $Accent } },
  @{ rel = 'imgs/actions/topright/off';     size = 72; draw = { param($g) Draw-Corner $g 'top' 'right' $FrameOff $DimGlyph } },

  @{ rel = 'imgs/actions/bottomleft/icon';  size = 20; draw = { param($g) Draw-Corner $g 'bottom' 'left' $FrameOn  $Accent } },
  @{ rel = 'imgs/actions/bottomleft/on';    size = 72; draw = { param($g) Draw-Corner $g 'bottom' 'left' $FrameOn  $Accent } },
  @{ rel = 'imgs/actions/bottomleft/off';   size = 72; draw = { param($g) Draw-Corner $g 'bottom' 'left' $FrameOff $DimGlyph } },

  @{ rel = 'imgs/actions/bottomright/icon'; size = 20; draw = { param($g) Draw-Corner $g 'bottom' 'right' $FrameOn  $Accent } },
  @{ rel = 'imgs/actions/bottomright/on';   size = 72; draw = { param($g) Draw-Corner $g 'bottom' 'right' $FrameOn  $Accent } },
  @{ rel = 'imgs/actions/bottomright/off';  size = 72; draw = { param($g) Draw-Corner $g 'bottom' 'right' $FrameOff $DimGlyph } },

  @{ rel = 'imgs/actions/opacity/icon';    size = 20; draw = { param($g) Draw-Opacity $g } },
  @{ rel = 'imgs/actions/opacity/key';     size = 72; draw = { param($g) Draw-Opacity $g } },
  @{ rel = 'imgs/actions/opacity/encoder'; size = 72; draw = { param($g) Draw-Opacity $g } },

  @{ rel = 'imgs/status/offline';          size = 72; draw = { param($g) Draw-Status $g 'offline' } },
  @{ rel = 'imgs/status/missing';          size = 72; draw = { param($g) Draw-Status $g 'missing' } },

  @{ rel = 'imgs/actions/zoom/icon';       size = 20; draw = { param($g) Draw-Zoom $g } },
  @{ rel = 'imgs/actions/zoom/key';        size = 72; draw = { param($g) Draw-Zoom $g } },
  @{ rel = 'imgs/actions/zoom/encoder';    size = 72; draw = { param($g) Draw-Zoom $g } },

  @{ rel = 'imgs/actions/panx/icon';       size = 20; draw = { param($g) Draw-Pan $g $true } },
  @{ rel = 'imgs/actions/panx/key';        size = 72; draw = { param($g) Draw-Pan $g $true } },
  @{ rel = 'imgs/actions/panx/encoder';    size = 72; draw = { param($g) Draw-Pan $g $true } },

  @{ rel = 'imgs/actions/pany/icon';       size = 20; draw = { param($g) Draw-Pan $g $false } },
  @{ rel = 'imgs/actions/pany/key';        size = 72; draw = { param($g) Draw-Pan $g $false } },
  @{ rel = 'imgs/actions/pany/encoder';    size = 72; draw = { param($g) Draw-Pan $g $false } },

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
