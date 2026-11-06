// Генерирует PNG-иконку помидорки заданного размера: go run ./tools/icon <size> <out.png>
package main

import (
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"strconv"
)

func clamp(v float64) uint8 { return uint8(math.Max(0, math.Min(255, v))) }

func main() {
	size, _ := strconv.Atoi(os.Args[1])
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	s := float64(size)
	ss := 4 // суперсэмплинг для гладких краёв
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var r, g, b, a float64
			for sy := 0; sy < ss; sy++ {
				for sx := 0; sx < ss; sx++ {
					px := (float64(x) + (float64(sx)+0.5)/float64(ss)) / s
					py := (float64(y) + (float64(sy)+0.5)/float64(ss)) / s
					cr, cg, cb, ca := shade(px, py)
					r += cr * ca
					g += cg * ca
					b += cb * ca
					a += ca
				}
			}
			n := float64(ss * ss)
			if a > 0 {
				img.SetNRGBA(x, y, color.NRGBA{clamp(r / a), clamp(g / a), clamp(b / a), clamp(a / n * 255)})
			}
		}
	}
	f, err := os.Create(os.Args[2])
	if err != nil {
		panic(err)
	}
	defer f.Close()
	png.Encode(f, img)
}

// shade возвращает цвет точки (координаты 0..1).
func shade(x, y float64) (r, g, b, a float64) {
	// фон — скруглённый квадрат (macOS style) с тёмным градиентом
	m := 0.1
	rad := 0.18
	inside := roundRect(x, y, m, m, 1-m, 1-m, rad)
	if !inside {
		return 0, 0, 0, 0
	}
	t := (x + y) / 2
	r, g, b, a = 34-14*t, 24-10*t, 40-14*t, 1

	// тень под помидором
	if d := ellipse(x, y, 0.5, 0.8, 0.27, 0.05); d < 1 {
		k := 0.35 * (1 - d)
		r, g, b = r*(1-k), g*(1-k), b*(1-k)
	}
	// тело помидора
	if d := ellipse(x, y, 0.5, 0.56, 0.31, 0.27); d < 1 {
		// объём: светлее слева сверху
		l := 1 - 0.45*math.Hypot(x-0.4, y-0.46)/0.4
		if os.Getenv("ICON_VARIANT") == "dev" {
			r, g, b = 80*l+10, 130*l+20, 245*l+10 // синяя «помидорка» для версии разработки
		} else {
			r, g, b = 239*l+20, 75*l, 63*l
		}
		// блик
		if hd := ellipse(x, y, 0.38, 0.45, 0.07, 0.04); hd < 1 {
			k := 0.55 * (1 - hd)
			r, g, b = r+(255-r)*k, g+(255-g)*k, b+(255-b)*k
		}
	}
	// листики: звёздочка из 5 лепестков
	cx, cy := 0.5, 0.31
	dx, dy := x-cx, y-cy
	ang := math.Atan2(dy, dx)
	dist := math.Hypot(dx, dy)
	petal := 0.03 + 0.085*math.Pow(math.Abs(math.Cos(ang*2.5)), 3)
	if dist < petal && y < 0.42 {
		r, g, b = 63, 174, 90
	}
	// хвостик
	if math.Abs(x-0.5) < 0.016 && y > 0.18 && y < 0.31 {
		r, g, b = 52, 150, 76
	}
	return
}

func ellipse(x, y, cx, cy, rx, ry float64) float64 {
	return math.Pow((x-cx)/rx, 2) + math.Pow((y-cy)/ry, 2)
}

func roundRect(x, y, x0, y0, x1, y1, r float64) bool {
	if x < x0 || x > x1 || y < y0 || y > y1 {
		return false
	}
	qx := math.Max(math.Max(x0+r-x, x-(x1-r)), 0)
	qy := math.Max(math.Max(y0+r-y, y-(y1-r)), 0)
	return qx*qx+qy*qy <= r*r
}
