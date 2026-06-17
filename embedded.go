package badapple

import "embed"

//go:embed web/* assets/source/ba.mp3 assets/generated/frames.badapple
var Embedded embed.FS
