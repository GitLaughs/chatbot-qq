package config

import (
	"fmt"
	"os"

	"github.com/BurntSushi/toml"
)

type Config struct {
	QQBot   QQBotConfig   `toml:"qqbot"`
	Runtime RuntimeConfig `toml:"runtime"`
	Filters FiltersConfig `toml:"filters"`
}

type QQBotConfig struct {
	AppID        string `toml:"app_id"`
	ClientSecret string `toml:"client_secret"`
	Sandbox      bool   `toml:"sandbox"`
	Intents      int64  `toml:"intents"`
}

type RuntimeConfig struct {
	LogLevel     string `toml:"log_level"`
	Echo         bool   `toml:"echo"`
	WebhookURL   string `toml:"webhook_url"`
	WebhookToken string `toml:"webhook_token"`
}

type FiltersConfig struct {
	AllowGroups []string `toml:"allow_groups"`
	AllowUsers  []string `toml:"allow_users"`
	RequireAt   bool     `toml:"require_at"`
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	var cfg Config
	if err := toml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	if cfg.QQBot.AppID == "" {
		return nil, fmt.Errorf("qqbot.app_id is required")
	}
	if cfg.QQBot.ClientSecret == "" {
		return nil, fmt.Errorf("qqbot.client_secret is required")
	}
	return &cfg, nil
}

