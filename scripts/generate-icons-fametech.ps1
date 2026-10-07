Add-Type -AssemblyName System.Drawing

$src = "d:\project code\fametech\public\fametechlogo.jpg"
$srcImg = [System.Drawing.Image]::FromFile($src)

function Resize-Square($image, $size, $outPath) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $bmp.SetResolution(96,96)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.DrawImage($image, 0, 0, $size, $size)
    $g.Dispose()
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $kb = [Math]::Round((Get-Item $outPath).Length / 1KB, 1)
    "  $outPath  (${size}x${size}, ${kb} KB)"
}

$targets = @(
    @{ size = 512; path = "d:\project code\fametech\app\icon.png" },
    @{ size = 180; path = "d:\project code\fametech\app\apple-icon.png" },
    @{ size = 192; path = "d:\project code\fametech\public\icons\icon-192x192.png" },
    @{ size = 512; path = "d:\project code\fametech\public\icons\icon-512x512.png" },
    @{ size = 180; path = "d:\project code\fametech\public\icons\apple-touch-icon.png" },
    @{ size = 1024; path = "d:\project code\fametech\public\logo.png" }
)

foreach ($t in $targets) {
    Resize-Square -image $srcImg -size $t.size -outPath $t.path
}

$srcImg.Dispose()
"Done."
