package main

import (
	"context"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"os/signal"
	"syscall"

	embedded "badapple"
	"badapple/src/extractor"
	"badapple/src/server"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	switch os.Args[1] {
	case "extract":
		if err := runExtract(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "extract: %v\n", err)
			os.Exit(1)
		}
	case "serve":
		if err := runServe(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "serve: %v\n", err)
			os.Exit(1)
		}
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage:")
	fmt.Fprintln(os.Stderr, "  badapple extract --images <dir> --audio <mp3> --out <file> [--fps <float>] [--threshold 200]")
	fmt.Fprintln(os.Stderr, "  badapple serve [--addr :8080]")
}

func runExtract(args []string) error {
	fs := flag.NewFlagSet("extract", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	var cfg extractor.Config
	fs.StringVar(&cfg.ImagesDir, "images", "assets/source/images", "directory containing numbered jpg frames")
	fs.StringVar(&cfg.AudioPath, "audio", "assets/source/ba.mp3", "audio file used to calculate default fps")
	fs.StringVar(&cfg.OutputPath, "out", "assets/generated/frames.badapple", "output binary frame data path")
	fs.IntVar(&cfg.Threshold, "threshold", 200, "RGB channel threshold for white pixels")
	fs.Float64Var(&cfg.OverrideFPS, "fps", 0, "explicit fps override; default is frameCount/audioDuration")

	if err := fs.Parse(args); err != nil {
		return err
	}
	return extractor.Extract(cfg)
}

func runServe(args []string) error {
	fsFlags := flag.NewFlagSet("serve", flag.ContinueOnError)
	fsFlags.SetOutput(os.Stderr)

	addr := fsFlags.String("addr", defaultServeAddr(), "HTTP listen address")
	if err := fsFlags.Parse(args); err != nil {
		return err
	}

	webFS, err := fs.Sub(embedded.Embedded, "web")
	if err != nil {
		return err
	}
	audio, err := embedded.Embedded.ReadFile("assets/source/ba.mp3")
	if err != nil {
		return err
	}
	frames, err := embedded.Embedded.ReadFile("assets/generated/frames.badapple")
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return server.Run(ctx, *addr, webFS, audio, frames)
}

func defaultServeAddr() string {
	if port := os.Getenv("PORT"); port != "" {
		return ":" + port
	}
	return ":8080"
}
