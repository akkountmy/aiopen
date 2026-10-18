Add-Type -AssemblyName System.Drawing

$total = 286.6524
$slices = @(
  @{ label='Промышленность';         value=71.7538; color='#1F4E79' },
  @{ label='Налоги на продукты';     value=33.0675; color='#D9A441' },
  @{ label='Транспорт и связь';      value=28.3340; color='#2E8B8B' },
  @{ label='Торговля';               value=27.1919; color='#C0504D' },
  @{ label='Прочие услуги';          value=22.3147; color='#8C8C8C' },
  @{ label='Сельское хозяйство';     value=19.7770; color='#6A994E' },
  @{ label='Строительство';          value=18.7782; color='#B5651D' },
  @{ label='Недвижимость';           value=18.1419; color='#7F6A93' },
  @{ label='Образование';            value=13.0478; color='#4F81BD' },
  @{ label='Здравоохранение';        value=12.2885; color='#C27BA0' },
  @{ label='Госуправление';          value=11.6239; color='#5B5B5B' },
  @{ label='Финансы и страхование';  value=10.3332; color='#31859C' }
)

$W = 1000; $H = 760; $scale = 2
$bmp = New-Object System.Drawing.Bitmap ($W*$scale), ($H*$scale)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.ScaleTransform($scale, $scale)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::White)

function Brush([string]$hex) {
  [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($hex))
}
function Fnt([double]$size, [string]$style = 'Regular') {
  [System.Drawing.Font]::new('Segoe UI', [single]$size, [System.Drawing.FontStyle]::$style, [System.Drawing.GraphicsUnit]::Pixel)
}
function DrawText($text, $font, $brush, [double]$x, [double]$y) {
  $g.DrawString($text, $font, $brush, [single]$x, [single]$y)
}
function DrawRight($text, $font, $brush, [double]$right, [double]$y) {
  $sf = [System.Drawing.StringFormat]::new()
  $sf.Alignment = [System.Drawing.StringAlignment]::Far
  $rect = [System.Drawing.RectangleF]::new([single]($right-320), [single]$y, [single]320, [single]24)
  $g.DrawString($text, $font, $brush, $rect, $sf)
}
function DrawCentered($text, $font, $brush, [double]$cx, [double]$cy, [double]$h = 48) {
  $sf = [System.Drawing.StringFormat]::new()
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $rect = [System.Drawing.RectangleF]::new([single]($cx-160), [single]($cy-$h/2), [single]320, [single]$h)
  $g.DrawString($text, $font, $brush, $rect, $sf)
}

$ink = Brush '#1A1A1A'; $mid = Brush '#666666'; $soft = Brush '#3D3D3D'; $spare = Brush '#8A8A8A'; $mist = Brush '#9A9A9A'; $white = Brush '#FFFFFF'; $dark = Brush '#1A1A1A'
$fTitle = Fnt 31 'Bold'; $fSub = Fnt 16; $fSum = Fnt 14.5; $fCap = Fnt 11.5; $fRow = Fnt 14.5; $fRowB = Fnt 14.5 'Bold'; $fPct = Fnt 15 'Bold'; $fCenter = Fnt 13.5; $fTotal = Fnt 41 'Bold'; $fFoot = Fnt 12.5

DrawText 'Из чего состоит ВВП Беларуси' $fTitle $ink 60 36
DrawText '2025 год · 286,65 млрд BYN · текущие цены' $fSub $mid 60 84

$services = 0.0; $goods = 0.0; $taxes = 0.0
foreach ($s in $slices) {
  if ($s.label -in @('Торговля','Транспорт и связь','Прочие услуги','Недвижимость','Образование','Здравоохранение','Госуправление','Финансы и страхование')) { $services += $s.value }
  if ($s.label -in @('Промышленность','Сельское хозяйство','Строительство')) { $goods += $s.value }
  if ($s.label -eq 'Налоги на продукты') { $taxes = $s.value }
}
$fmtPct = { param($v) ([math]::Round($v*100,1)).ToString('0.0',[System.Globalization.CultureInfo]::GetCultureInfo('ru-RU')) + '%' }
$summary = 'Услуги — ' + (& $fmtPct ($services/$total)) + ' · Товарный сектор — ' + (& $fmtPct ($goods/$total)) + ' · Чистые налоги на продукты — ' + (& $fmtPct ($taxes/$total))
DrawText $summary $fSum $soft 60 112

$pen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#ECECEC'), 1)
$g.DrawLine($pen, 60, 140, 940, 140)

$cx = 350.0; $cy = 430.0; $R = 205.0; $rr = 115.0
$angle = -90.0; $gap = 0.35
foreach ($s in $slices) {
  $share = $s.value / $total
  $sweep = $share * 360.0
  $br = Brush $s.color
  $g.FillPie($br, [single]($cx-$R), [single]($cy-$R), [single](2*$R), [single](2*$R), [single]($angle + $gap/2), [single]($sweep - $gap))
  $pct = $share * 100
  if ($pct -ge 6) {
    $midA = ($angle + $sweep/2) * [math]::PI / 180.0
    $mx = $cx + (($R+$rr)/2) * [math]::Cos($midA)
    $my = $cy + (($R+$rr)/2) * [math]::Sin($midA)
    $tone = if ($s.color -in @('#D9A441','#C27BA0','#8C8C8C')) { $dark } else { $white }
    DrawCentered ((& $fmtPct $share)) $fPct $tone $mx $my
  }
  $angle += $sweep
}
$holePen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, 1.2)
$g.FillEllipse($white, [single]($cx-$rr), [single]($cy-$rr), [single](2*$rr), [single](2*$rr))
$g.DrawEllipse($holePen, [single]($cx-$rr), [single]($cy-$rr), [single](2*$rr), [single](2*$rr))
DrawCentered 'ВВП — 2025' $fCenter $mist $cx ($cy-30)
DrawCentered '286,65' $fTotal $ink $cx ($cy+2) 70
DrawCentered 'млрд BYN' $fCenter $mist $cx ($cy+40)

DrawRight 'ДОЛЯ' $fCap $mist 870 136
DrawRight 'МЛРД BYN' $fCap $mist 940 136
$i = 0
foreach ($s in $slices) {
  $y = 168.0 + $i*35.0
  $br = Brush $s.color
  $g.FillRectangle($br, [single]620, [single]($y-11), [single]13, [single]13)
  DrawText $s.label $fRow $ink 643 ($y-9)
  DrawRight ((& $fmtPct ($s.value/$total))) $fRowB $ink 870 ($y-9)
  $v = $s.value.ToString('0.00',[System.Globalization.CultureInfo]::GetCultureInfo('ru-RU'))
  DrawRight $v $fRow $mid 940 ($y-9)
  $i++
}

$g.DrawLine($pen, 60, 662, 940, 662)
DrawText 'Источник: Национальный статистический комитет Республики Беларусь, ВВП производственным методом, 2025 год (годовые данные, текущие цены).' $fFoot $spare 60 680
DrawText 'Промышленность = добывающая + обрабатывающая + энергоснабжение + водоснабжение; Транспорт и связь = транспорт + информация и связь;' $fFoot $spare 60 700
DrawText 'Прочие услуги = профессиональные и административные, гостиницы и питание, культура и спорт, прочие.' $fFoot $spare 60 720
DrawText 'Сумма долей может отличаться от 100% на 0,1 п.п. из-за округления.' $fFoot $spare 60 740

$out = 'D:\DSHarness-0.1\DSH.OPEN.WEB\charts\vvp-belarus-2025.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "saved $out"
