package game

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// Money stores hundredths as integers. JSON uses ordinary decimal coins.
type Money int64

func Coins(n float64) Money { return Money(math.Round(n * 100)) }
func (m Money) String() string {
	if m < 0 {
		return "-" + Money(-m).String()
	}
	return fmt.Sprintf("%d.%02d", int64(m)/100, int64(m)%100)
}
func (m Money) MarshalJSON() ([]byte, error) { return []byte(m.String()), nil }
func (m *Money) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(bytes.Trim(b, "\"")))
	parts := strings.Split(s, ".")
	if len(parts) > 2 {
		return errors.New("invalid coin amount")
	}
	whole, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || whole < 0 || whole > 1e13 {
		return errors.New("invalid coin amount")
	}
	cents := int64(0)
	if len(parts) == 2 {
		if len(parts[1]) > 2 || len(parts[1]) == 0 {
			return errors.New("coin amount needs at most two decimals")
		}
		fraction := parts[1]
		if len(fraction) == 1 {
			fraction += "0"
		}
		cents, err = strconv.ParseInt(fraction, 10, 64)
		if err != nil {
			return err
		}
	}
	*m = Money(whole*100 + cents)
	return nil
}
