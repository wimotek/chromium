package nginx

import (
	"context"
	"fmt"
	"os/exec"
	"time"
)

type Executor struct{}

func NewExecutor() *Executor {
	return &Executor{}
}

// 严禁 /bin/sh -c 拼接字符串，杜绝任何形式的命令注入
func (e *Executor) TestConfig() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "nginx", "-t")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("语法校验失败: %s", string(out))
	}
	return nil
}

func (e *Executor) Reload() error {
	if err := e.TestConfig(); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "nginx", "-s", "reload")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("热重载失败: %s", string(out))
	}
	return nil
}