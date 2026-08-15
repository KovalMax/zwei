package email

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/smtp"
	"time"
)

type SMTP struct {
	address string
	host    string
	from    string
	user    string
	pass    string
	timeout time.Duration
}

func NewSMTP(host, port, from, username, password string) *SMTP {
	return &SMTP{address: host + ":" + port, host: host, from: from, user: username, pass: password, timeout: 10 * time.Second}
}

func (s *SMTP) SendActivation(ctx context.Context, recipient, displayName, link string) error {
	return s.send(ctx, recipient, "Activate your Zwei account", fmt.Sprintf("Hello %s,\r\n\r\nYour Zwei account has been approved. Activate it here:\r\n%s\r\n\r\nThis link expires in 72 hours.\r\n", displayName, link))
}

func (s *SMTP) SendInvitation(ctx context.Context, recipient, link string) error {
	return s.send(ctx, recipient, "Your Zwei invitation", fmt.Sprintf("Hello,\r\n\r\nYou have been invited to Zwei. Create your account here:\r\n%s\r\n\r\nThis invitation expires in 7 days.\r\n", link))
}

func (s *SMTP) send(ctx context.Context, recipient, subject, message string) error {
	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()
	connection, err := (&net.Dialer{}).DialContext(ctx, "tcp", s.address)
	if err != nil {
		return err
	}
	defer connection.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = connection.SetDeadline(deadline)
	}
	client, err := smtp.NewClient(connection, s.host)
	if err != nil {
		return err
	}
	defer client.Close()
	if ok, _ := client.Extension("STARTTLS"); ok {
		if err := client.StartTLS(&tls.Config{ServerName: s.host, MinVersion: tls.VersionTLS12}); err != nil {
			return err
		}
	}
	if s.user != "" {
		if err := client.Auth(smtp.PlainAuth("", s.user, s.pass, s.host)); err != nil {
			return err
		}
	}
	body := fmt.Sprintf("To: %s\r\nSubject: %s\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n%s", recipient, subject, message)
	if err := client.Mail(s.from); err != nil {
		return err
	}
	if err := client.Rcpt(recipient); err != nil {
		return err
	}
	writer, err := client.Data()
	if err != nil {
		return err
	}
	if _, err := writer.Write([]byte(body)); err != nil {
		_ = writer.Close()
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	return client.Quit()
}
