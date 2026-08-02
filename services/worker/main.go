package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	logger := slog.Default()
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()

	logger.Info("worker started")
	for {
		select {
		case <-ticker.C:
			logger.Info("worker tick")
		case <-ctx.Done():
			logger.Info("worker stopped")
			return
		}
	}
}
