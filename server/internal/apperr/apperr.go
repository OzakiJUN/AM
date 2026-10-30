// Package apperr defines errors that are safe to show to clients.
// Each has a stable code (see docs/protocol.md) and an HTTP status.
package apperr

import (
	"errors"
	"net/http"
)

type Error struct {
	Code    string
	Message string
	Status  int
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func New(status int, code, msg string) *Error {
	return &Error{Code: code, Message: msg, Status: status}
}

// As returns the *Error inside err, or nil.
func As(err error) *Error {
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	return nil
}

var (
	ErrBadRequest      = New(http.StatusBadRequest, "bad_request", "malformed request")
	ErrUnauthorized    = New(http.StatusUnauthorized, "unauthorized", "missing or invalid token")
	ErrBanned          = New(http.StatusForbidden, "banned", "this account is banned")
	ErrWrongPassword   = New(http.StatusUnauthorized, "wrong_credentials", "wrong username or password")
	ErrInvalidInvite   = New(http.StatusBadRequest, "invalid_invite", "invite code is invalid or already used")
	ErrUsernameTaken   = New(http.StatusConflict, "username_taken", "username is already taken")
	ErrInvalidUsername = New(http.StatusBadRequest, "invalid_username", "username must be 3-20 letters, digits or _")
	ErrWeakPassword    = New(http.StatusBadRequest, "weak_password", "password must be at least 8 characters")
	ErrInvalidName     = New(http.StatusBadRequest, "invalid_display_name", "display name must be 1-32 characters")
	ErrInviteLimit     = New(http.StatusForbidden, "invite_limit", "no invite codes left")
	ErrUserNotFound    = New(http.StatusNotFound, "user_not_found", "user not found")
	ErrSelf            = New(http.StatusBadRequest, "self", "cannot do this to yourself")
	ErrBlocked         = New(http.StatusForbidden, "blocked", "one of you has blocked the other")
	ErrNotFound        = New(http.StatusNotFound, "not_found", "not found")
	ErrNotMember       = New(http.StatusForbidden, "not_member", "you are not in this conversation")
	ErrMuted           = New(http.StatusForbidden, "muted", "you are muted in this conversation")
	ErrEmptyMessage    = New(http.StatusBadRequest, "empty_message", "message is empty")
	ErrTooLong         = New(http.StatusBadRequest, "too_long", "message is too long")
	ErrMissingClientID = New(http.StatusBadRequest, "missing_client_msg_id", "client_msg_id is required")
	ErrCannotStrike    = New(http.StatusForbidden, "cannot_strike", "you can only strike your own messages")
	ErrAlreadyStruck   = New(http.StatusConflict, "already_struck", "message is already struck")
	ErrNotImplemented  = New(http.StatusNotImplemented, "not_implemented", "not implemented yet")
	ErrRateLimited     = New(http.StatusTooManyRequests, "rate_limited", "too many attempts, try again later")

	ErrNoPermission     = New(http.StatusForbidden, "no_permission", "you do not have permission to do this")
	ErrNotGroup         = New(http.StatusBadRequest, "not_group", "this conversation is not a group")
	ErrInvalidGroupName = New(http.StatusBadRequest, "invalid_group_name", "group name must be 1-32 characters")
	ErrNoticeTooLong    = New(http.StatusBadRequest, "notice_too_long", "group notice must be at most 1000 characters")
	ErrOwnerCannotLeave = New(http.StatusBadRequest, "owner_cannot_leave", "transfer the group or dissolve it first")
	ErrGroupFull        = New(http.StatusForbidden, "group_full", "the group is full")
	ErrNoJoinRequest    = New(http.StatusNotFound, "no_join_request", "no pending join request for this user")
	ErrNotInGroup       = New(http.StatusNotFound, "not_in_group", "that user is not in this group")
	ErrNotPublic        = New(http.StatusForbidden, "not_public", "this channel is not public")

	ErrReasonRequired = New(http.StatusBadRequest, "reason_required", "a reason is required")
	ErrNoPassword     = New(http.StatusBadRequest, "no_password", "this account does not use a password")

	ErrBioTooLong      = New(http.StatusBadRequest, "bio_too_long", "signature must be at most 100 characters")
	ErrInvalidActivity = New(http.StatusBadRequest, "invalid_activity", "unknown activity, or its text is too long / missing")
	ErrLeftServer      = New(http.StatusForbidden, "left_server", "you left this server; a new invite code is needed to come back")
)
