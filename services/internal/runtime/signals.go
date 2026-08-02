package runtime

import (
	"context"
	"os"
	"os/signal"
	"syscall"
)

func SignalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
}
