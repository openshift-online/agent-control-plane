package sessions

import "time"

type SessionEvent struct {
	ID          string     `gorm:"column:id;primaryKey;type:varchar(36)" json:"id"`
	SessionID   string     `gorm:"column:session_id;type:varchar(36)" json:"session_id"`
	Seq         int64      `gorm:"column:seq;->" json:"seq"`
	EventType   string     `gorm:"column:event_type;type:varchar(255)" json:"event_type"`
	Payload     string     `gorm:"column:payload;type:text" json:"payload"`
	CreatedAt   time.Time  `gorm:"column:created_at;type:timestamptz" json:"created_at"`
	CompletedAt *time.Time `gorm:"column:completed_at;type:timestamptz" json:"completed_at"`
	EventCount  int32      `gorm:"column:event_count;type:int;default:1" json:"event_count"`
}

func (SessionEvent) TableName() string { return "session_events" }
