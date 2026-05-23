package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"ccconnect-qq/internal/adapter"
	"ccconnect-qq/internal/config"
	"ccconnect-qq/internal/qqbot"
)

func main() {
	configPath := flag.String("config", "configs/qqbot.local.toml", "path to config file")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		slog.Error("load config failed", "error", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	webhook := adapter.Webhook{
		URL:   cfg.Runtime.WebhookURL,
		Token: cfg.Runtime.WebhookToken,
	}
	client := &qqbot.Client{
		AppID:        cfg.QQBot.AppID,
		ClientSecret: cfg.QQBot.ClientSecret,
		Sandbox:      cfg.QQBot.Sandbox,
	}
	gw := &qqbot.Gateway{
		Client:  client,
		Intents: cfg.QQBot.Intents,
		OnMessage: func(ctx context.Context, msg adapter.Message) {
			if !allowed(msg.GroupID, cfg.Filters.AllowGroups) || !allowed(msg.UserID, cfg.Filters.AllowUsers) {
				return
			}
			printJSON(msg)
			if webhook.Enabled() {
				if err := webhook.Send(ctx, msg); err != nil {
					slog.Warn("webhook send failed", "error", err, "session", msg.SessionKey)
				}
			}
			if cfg.Runtime.Echo {
				reply := "收到：" + msg.Content
				if msg.GroupID != "" {
					if err := client.SendGroupText(ctx, msg.GroupID, reply, msg.MessageID); err != nil {
						slog.Warn("send group echo failed", "error", err)
					}
				} else if msg.UserID != "" {
					if err := client.SendUserText(ctx, msg.UserID, reply, msg.MessageID); err != nil {
						slog.Warn("send user echo failed", "error", err)
					}
				}
			}
		},
	}

	slog.Info("starting qqbot adapter", "config", *configPath, "sandbox", cfg.QQBot.Sandbox)
	if err := gw.Run(ctx); err != nil && ctx.Err() == nil {
		slog.Error("gateway stopped", "error", err)
		os.Exit(1)
	}
}

func printJSON(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		fmt.Println(`{"error":"marshal failed"}`)
		return
	}
	fmt.Println(string(b))
}

func allowed(id string, allow []string) bool {
	if len(allow) == 0 || id == "" {
		return true
	}
	for _, v := range allow {
		if v == id {
			return true
		}
	}
	return false
}
