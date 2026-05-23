package adapter

type Message struct {
	Platform   string `json:"platform"`
	SessionKey string `json:"session_key"`
	EventType  string `json:"event_type"`
	GroupID    string `json:"group_id,omitempty"`
	UserID     string `json:"user_id,omitempty"`
	MessageID  string `json:"message_id,omitempty"`
	Content    string `json:"content"`
	RawType    string `json:"raw_type,omitempty"`
}

