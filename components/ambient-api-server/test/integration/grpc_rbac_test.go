package integration

import (
	"context"
	"testing"
	"time"

	. "github.com/onsi/gomega"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"github.com/ambient-code/platform/components/ambient-api-server/cmd/ambient-api-server/environments"
	pb "github.com/ambient-code/platform/components/ambient-api-server/pkg/api/grpc/ambient/v1"
	"github.com/openshift-online/rh-trex-ai/pkg/api"
)

func skipIfAuthzDisabled(t *testing.T) {
	t.Helper()
	if !environments.Environment().Config.Auth.EnableAuthz {
		t.Skip("skipping gRPC RBAC test: enable-authz is false in this environment")
	}
}

func seedGlobalAdminBinding(t *testing.T, username string) {
	t.Helper()
	g := environments.Environment().Database.SessionFactory.New(context.Background())
	var roleID string
	g.Raw(`SELECT id FROM roles WHERE name = 'platform:admin' AND deleted_at IS NULL`).Scan(&roleID)
	if roleID == "" {
		t.Fatal("platform:admin role not found")
	}
	g.Exec(
		`INSERT INTO role_bindings (id, role_id, scope, user_id, created_at, updated_at)
		 VALUES (?, ?, 'global', ?, NOW(), NOW())`,
		api.NewID(), roleID, username,
	)
}

func insertSession(t *testing.T, sessionID, name, projectID string) {
	t.Helper()
	g := environments.Environment().Database.SessionFactory.New(context.Background())
	err := g.Exec(
		`INSERT INTO sessions (id, name, project_id, created_at, updated_at)
		 VALUES (?, ?, ?, NOW(), NOW())`,
		sessionID, name, projectID,
	).Error
	Expect(err).NotTo(HaveOccurred())
}

func grpcConn(t *testing.T) *grpc.ClientConn {
	t.Helper()
	conn, err := grpc.NewClient(
		testHelper.GRPCAddress(),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	Expect(err).NotTo(HaveOccurred())
	return conn
}

func grpcCtx(token string) context.Context {
	return metadata.AppendToOutgoingContext(context.Background(), "authorization", "Bearer "+token)
}

// --- Projects ---

func TestGRPCRBAC_Projects(t *testing.T) {
	skipIfAuthzDisabled(t)
	RegisterTestingT(t)
	testHelper.DBFactory.ResetDB()
	ensureBuiltInRoles(t)

	conn := grpcConn(t)
	defer func() { _ = conn.Close() }()
	client := pb.NewProjectServiceClient(conn)

	t.Run("owner_lists_own_project", func(t *testing.T) {
		RegisterTestingT(t)
		username := "owner-proj-user"
		account := testHelper.NewAccount(username, "Owner User", "owner-proj@test.com")
		token := testHelper.CreateJWTString(account)

		projID, _ := setupProjectWithRole(t, username, "project:owner")

		resp, err := client.ListProjects(grpcCtx(token), &pb.ListProjectsRequest{Page: 1, Size: 100})
		Expect(err).NotTo(HaveOccurred())
		Expect(resp.GetMetadata().GetTotal()).To(Equal(int32(1)))
		Expect(resp.GetItems()).To(HaveLen(1))
		Expect(resp.GetItems()[0].GetMetadata().GetId()).To(Equal(projID))
	})

	t.Run("viewer_lists_own_project", func(t *testing.T) {
		RegisterTestingT(t)
		username := "viewer-proj-user"
		account := testHelper.NewAccount(username, "Viewer User", "viewer-proj@test.com")
		token := testHelper.CreateJWTString(account)

		projID, _ := setupProjectWithRole(t, username, "project:viewer")

		resp, err := client.ListProjects(grpcCtx(token), &pb.ListProjectsRequest{Page: 1, Size: 100})
		Expect(err).NotTo(HaveOccurred())

		var found bool
		for _, p := range resp.GetItems() {
			if p.GetMetadata().GetId() == projID {
				found = true
			}
		}
		Expect(found).To(BeTrue(), "viewer should see their own project")
	})

	t.Run("no_bindings_gets_empty_list", func(t *testing.T) {
		RegisterTestingT(t)
		account := testHelper.NewAccount("no-bind-user", "No Bind", "nobind@test.com")
		token := testHelper.CreateJWTString(account)

		resp, err := client.ListProjects(grpcCtx(token), &pb.ListProjectsRequest{Page: 1, Size: 100})
		Expect(err).NotTo(HaveOccurred())
		Expect(resp.GetItems()).To(BeEmpty())
		Expect(resp.GetMetadata().GetTotal()).To(Equal(int32(0)))
	})

	t.Run("admin_sees_all_projects", func(t *testing.T) {
		RegisterTestingT(t)
		username := "admin-proj-user"
		account := testHelper.NewAccount(username, "Admin User", "admin-proj@test.com")
		token := testHelper.CreateJWTString(account)
		seedGlobalAdminBinding(t, username)

		g := environments.Environment().Database.SessionFactory.New(context.Background())
		var projectCount int64
		g.Raw(`SELECT COUNT(*) FROM projects WHERE deleted_at IS NULL`).Scan(&projectCount)

		resp, err := client.ListProjects(grpcCtx(token), &pb.ListProjectsRequest{Page: 1, Size: 100})
		Expect(err).NotTo(HaveOccurred())
		Expect(resp.GetMetadata().GetTotal()).To(Equal(int32(projectCount)))
	})

	t.Run("cross_project_isolation", func(t *testing.T) {
		RegisterTestingT(t)
		usernameA := "iso-user-a"
		usernameB := "iso-user-b"
		accountA := testHelper.NewAccount(usernameA, "User A", "isoa@test.com")
		accountB := testHelper.NewAccount(usernameB, "User B", "isob@test.com")
		tokenA := testHelper.CreateJWTString(accountA)
		tokenB := testHelper.CreateJWTString(accountB)

		projA, _ := setupProjectWithRole(t, usernameA, "project:owner")
		projB, _ := setupProjectWithRole(t, usernameB, "project:owner")

		respA, err := client.ListProjects(grpcCtx(tokenA), &pb.ListProjectsRequest{Page: 1, Size: 100})
		Expect(err).NotTo(HaveOccurred())
		for _, p := range respA.GetItems() {
			Expect(p.GetMetadata().GetId()).NotTo(Equal(projB), "userA must not see projB")
		}

		respB, err := client.ListProjects(grpcCtx(tokenB), &pb.ListProjectsRequest{Page: 1, Size: 100})
		Expect(err).NotTo(HaveOccurred())
		for _, p := range respB.GetItems() {
			Expect(p.GetMetadata().GetId()).NotTo(Equal(projA), "userB must not see projA")
		}
	})
}

// --- Sessions ---

func TestGRPCRBAC_Sessions(t *testing.T) {
	skipIfAuthzDisabled(t)
	RegisterTestingT(t)
	testHelper.DBFactory.ResetDB()
	ensureBuiltInRoles(t)

	conn := grpcConn(t)
	defer func() { _ = conn.Close() }()
	client := pb.NewSessionServiceClient(conn)

	t.Run("editor_lists_sessions_in_own_project", func(t *testing.T) {
		RegisterTestingT(t)
		username := "editor-sess-user"
		account := testHelper.NewAccount(username, "Editor User", "editor-sess@test.com")
		token := testHelper.CreateJWTString(account)

		projA, _ := setupProjectWithRole(t, username, "project:editor")

		otherProjID := api.NewID()
		g := environments.Environment().Database.SessionFactory.New(context.Background())
		err := g.Exec(
			`INSERT INTO projects (id, name, created_at, updated_at)
			 VALUES (?, ?, NOW(), NOW())`,
			otherProjID, "other-project",
		).Error
		Expect(err).NotTo(HaveOccurred())

		sessA := api.NewID()
		sessB := api.NewID()
		insertSession(t, sessA, "session-in-a", projA)
		insertSession(t, sessB, "session-in-other", otherProjID)

		resp, err := client.ListSessions(grpcCtx(token), &pb.ListSessionsRequest{Page: 1, Size: 100})
		Expect(err).NotTo(HaveOccurred())

		var ids []string
		for _, s := range resp.GetItems() {
			ids = append(ids, s.GetMetadata().GetId())
		}
		Expect(ids).To(ContainElement(sessA))
		Expect(ids).NotTo(ContainElement(sessB))
	})

	t.Run("viewer_cannot_see_other_project_sessions", func(t *testing.T) {
		RegisterTestingT(t)
		username := "viewer-sess-user"
		account := testHelper.NewAccount(username, "Viewer User", "viewer-sess@test.com")
		token := testHelper.CreateJWTString(account)

		setupProjectWithRole(t, username, "project:viewer")

		otherProjID := api.NewID()
		g := environments.Environment().Database.SessionFactory.New(context.Background())
		err := g.Exec(
			`INSERT INTO projects (id, name, created_at, updated_at)
			 VALUES (?, ?, NOW(), NOW())`,
			otherProjID, "viewer-other-proj",
		).Error
		Expect(err).NotTo(HaveOccurred())

		sessOther := api.NewID()
		insertSession(t, sessOther, "session-other", otherProjID)

		resp, err := client.ListSessions(grpcCtx(token), &pb.ListSessionsRequest{Page: 1, Size: 100})
		Expect(err).NotTo(HaveOccurred())

		for _, s := range resp.GetItems() {
			Expect(s.GetMetadata().GetId()).NotTo(Equal(sessOther))
		}
	})

	t.Run("admin_sees_all_sessions", func(t *testing.T) {
		RegisterTestingT(t)
		username := "admin-sess-user"
		account := testHelper.NewAccount(username, "Admin User", "admin-sess@test.com")
		token := testHelper.CreateJWTString(account)
		seedGlobalAdminBinding(t, username)

		g := environments.Environment().Database.SessionFactory.New(context.Background())
		var sessionCount int64
		g.Raw(`SELECT COUNT(*) FROM sessions WHERE deleted_at IS NULL`).Scan(&sessionCount)

		resp, err := client.ListSessions(grpcCtx(token), &pb.ListSessionsRequest{Page: 1, Size: 100})
		Expect(err).NotTo(HaveOccurred())
		Expect(resp.GetMetadata().GetTotal()).To(Equal(int32(sessionCount)))
	})
}

// --- WatchSessionMessages ---

func TestGRPCRBAC_WatchSessionMessages(t *testing.T) {
	skipIfAuthzDisabled(t)
	RegisterTestingT(t)
	testHelper.DBFactory.ResetDB()
	ensureBuiltInRoles(t)

	conn := grpcConn(t)
	defer func() { _ = conn.Close() }()
	client := pb.NewSessionServiceClient(conn)

	t.Run("authorized_user_receives_messages", func(t *testing.T) {
		RegisterTestingT(t)
		username := "msg-owner-user"
		account := testHelper.NewAccount(username, "Owner User", "msg-owner@test.com")
		token := testHelper.CreateJWTString(account)

		projID, _ := setupProjectWithRole(t, username, "project:owner")

		sessID := api.NewID()
		insertSession(t, sessID, "msg-session", projID)

		ctx := grpcCtx(token)
		watchCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()

		stream, err := client.WatchSessionMessages(watchCtx, &pb.WatchSessionMessagesRequest{
			SessionId: sessID,
			AfterSeq:  0,
		})
		Expect(err).NotTo(HaveOccurred())

		received := make(chan *pb.SessionMessage, 5)
		go func() {
			for {
				msg, recvErr := stream.Recv()
				if recvErr != nil {
					return
				}
				select {
				case received <- msg:
				case <-watchCtx.Done():
					return
				}
			}
		}()

		time.Sleep(100 * time.Millisecond)

		pushed, err := client.PushSessionMessage(ctx, &pb.PushSessionMessageRequest{
			SessionId: sessID,
			EventType: "system",
			Payload:   "rbac-test-msg",
		})
		Expect(err).NotTo(HaveOccurred())

		select {
		case msg := <-received:
			Expect(msg.GetSessionId()).To(Equal(sessID))
			Expect(msg.GetPayload()).To(Equal("rbac-test-msg"))
			Expect(msg.GetSeq()).To(Equal(pushed.GetSeq()))
		case <-time.After(5 * time.Second):
			t.Fatal("timed out waiting for message on authorized stream")
		}
	})

	t.Run("wrong_project_denied", func(t *testing.T) {
		RegisterTestingT(t)
		userA := "msg-a-user"
		userB := "msg-b-user"
		testHelper.NewAccount(userA, "User A", "msga@test.com")
		accountB := testHelper.NewAccount(userB, "User B", "msgb@test.com")
		tokenB := testHelper.CreateJWTString(accountB)

		projA, _ := setupProjectWithRole(t, userA, "project:owner")
		setupProjectWithRole(t, userB, "project:viewer")

		sessA := api.NewID()
		insertSession(t, sessA, "session-a", projA)

		ctx := grpcCtx(tokenB)
		watchCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()

		stream, err := client.WatchSessionMessages(watchCtx, &pb.WatchSessionMessagesRequest{
			SessionId: sessA,
			AfterSeq:  0,
		})
		if err != nil {
			st, ok := status.FromError(err)
			Expect(ok).To(BeTrue())
			Expect(st.Code()).To(Equal(codes.PermissionDenied))
			return
		}

		_, recvErr := stream.Recv()
		Expect(recvErr).To(HaveOccurred())
		st, ok := status.FromError(recvErr)
		Expect(ok).To(BeTrue())
		Expect(st.Code()).To(Equal(codes.PermissionDenied))
	})

	t.Run("no_auth_denied", func(t *testing.T) {
		RegisterTestingT(t)

		projID := api.NewID()
		g := environments.Environment().Database.SessionFactory.New(context.Background())
		err := g.Exec(
			`INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, NOW(), NOW())`,
			projID, "noauth-proj",
		).Error
		Expect(err).NotTo(HaveOccurred())

		sessID := api.NewID()
		insertSession(t, sessID, "noauth-session", projID)

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		stream, err := client.WatchSessionMessages(ctx, &pb.WatchSessionMessagesRequest{
			SessionId: sessID,
			AfterSeq:  0,
		})
		if err != nil {
			st, ok := status.FromError(err)
			Expect(ok).To(BeTrue())
			Expect(st.Code()).To(Equal(codes.Unauthenticated))
			return
		}

		_, recvErr := stream.Recv()
		Expect(recvErr).To(HaveOccurred())
		st, ok := status.FromError(recvErr)
		Expect(ok).To(BeTrue())
		Expect(st.Code()).To(Equal(codes.Unauthenticated))
	})

	t.Run("admin_watches_any_session", func(t *testing.T) {
		RegisterTestingT(t)
		username := "msg-admin-user"
		account := testHelper.NewAccount(username, "Admin User", "msg-admin@test.com")
		token := testHelper.CreateJWTString(account)
		seedGlobalAdminBinding(t, username)

		otherUser := "msg-other-owner"
		testHelper.NewAccount(otherUser, "Other Owner", "msg-other@test.com")
		projID, _ := setupProjectWithRole(t, otherUser, "project:owner")

		sessID := api.NewID()
		insertSession(t, sessID, "admin-watch-session", projID)

		ctx := grpcCtx(token)
		watchCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()

		stream, err := client.WatchSessionMessages(watchCtx, &pb.WatchSessionMessagesRequest{
			SessionId: sessID,
			AfterSeq:  0,
		})
		Expect(err).NotTo(HaveOccurred())

		received := make(chan *pb.SessionMessage, 5)
		go func() {
			for {
				msg, recvErr := stream.Recv()
				if recvErr != nil {
					return
				}
				select {
				case received <- msg:
				case <-watchCtx.Done():
					return
				}
			}
		}()

		time.Sleep(100 * time.Millisecond)

		pushed, err := client.PushSessionMessage(ctx, &pb.PushSessionMessageRequest{
			SessionId: sessID,
			EventType: "system",
			Payload:   "admin-msg",
		})
		Expect(err).NotTo(HaveOccurred())

		select {
		case msg := <-received:
			Expect(msg.GetSeq()).To(Equal(pushed.GetSeq()))
			Expect(msg.GetPayload()).To(Equal("admin-msg"))
		case <-time.After(5 * time.Second):
			t.Fatal("timed out waiting for message on admin stream")
		}
	})
}

// --- WatchUsers ---

func TestGRPCRBAC_WatchUsers(t *testing.T) {
	skipIfAuthzDisabled(t)
	RegisterTestingT(t)
	testHelper.DBFactory.ResetDB()
	ensureBuiltInRoles(t)

	testHelper.StartControllersServer()
	time.Sleep(500 * time.Millisecond)

	conn := grpcConn(t)
	defer func() { _ = conn.Close() }()
	client := pb.NewUserServiceClient(conn)

	t.Run("admin_can_watch", func(t *testing.T) {
		RegisterTestingT(t)
		username := "watch-admin-user"
		account := testHelper.NewAccount(username, "Admin User", "watch-admin@test.com")
		token := testHelper.CreateJWTString(account)
		seedGlobalAdminBinding(t, username)

		ctx := grpcCtx(token)
		watchCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()

		stream, err := client.WatchUsers(watchCtx, &pb.WatchUsersRequest{})
		Expect(err).NotTo(HaveOccurred())

		received := make(chan *pb.UserWatchEvent, 10)
		go func() {
			for {
				event, recvErr := stream.Recv()
				if recvErr != nil {
					return
				}
				select {
				case received <- event:
				case <-watchCtx.Done():
					return
				}
			}
		}()

		time.Sleep(200 * time.Millisecond)

		_, err = client.CreateUser(ctx, &pb.CreateUserRequest{
			Username: "watch-admin-created-user",
			Name:     "Created By Admin",
		})
		Expect(err).NotTo(HaveOccurred())

		select {
		case event := <-received:
			Expect(event.GetType()).To(Equal(pb.EventType_EVENT_TYPE_CREATED))
			Expect(event.GetUser()).NotTo(BeNil())
		case <-time.After(10 * time.Second):
			t.Fatal("timed out waiting for WatchUsers event as admin")
		}
	})

	t.Run("non_admin_denied", func(t *testing.T) {
		RegisterTestingT(t)
		username := "watch-nonadmin-user"
		account := testHelper.NewAccount(username, "Non-Admin User", "watch-nonadmin@test.com")
		token := testHelper.CreateJWTString(account)
		setupProjectWithRole(t, username, "project:owner")

		ctx := grpcCtx(token)
		watchCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()

		stream, err := client.WatchUsers(watchCtx, &pb.WatchUsersRequest{})
		if err != nil {
			st, ok := status.FromError(err)
			Expect(ok).To(BeTrue())
			Expect(st.Code()).To(Equal(codes.PermissionDenied))
			return
		}

		_, recvErr := stream.Recv()
		Expect(recvErr).To(HaveOccurred())
		st, ok := status.FromError(recvErr)
		Expect(ok).To(BeTrue())
		Expect(st.Code()).To(Equal(codes.PermissionDenied))
	})
}

// --- Malicious ---

func TestGRPCRBAC_Malicious(t *testing.T) {
	skipIfAuthzDisabled(t)
	RegisterTestingT(t)
	testHelper.DBFactory.ResetDB()
	ensureBuiltInRoles(t)

	conn := grpcConn(t)
	defer func() { _ = conn.Close() }()
	projectClient := pb.NewProjectServiceClient(conn)
	sessionClient := pb.NewSessionServiceClient(conn)

	t.Run("no_auth_metadata", func(t *testing.T) {
		RegisterTestingT(t)
		ctx := context.Background()

		_, err := projectClient.ListProjects(ctx, &pb.ListProjectsRequest{Page: 1, Size: 10})
		Expect(err).To(HaveOccurred())
		st, ok := status.FromError(err)
		Expect(ok).To(BeTrue())
		Expect(st.Code()).To(Equal(codes.Unauthenticated))
	})

	t.Run("empty_bearer_token", func(t *testing.T) {
		RegisterTestingT(t)
		ctx := metadata.AppendToOutgoingContext(context.Background(), "authorization", "Bearer ")

		_, err := projectClient.ListProjects(ctx, &pb.ListProjectsRequest{Page: 1, Size: 10})
		Expect(err).To(HaveOccurred())
		st, ok := status.FromError(err)
		Expect(ok).To(BeTrue())
		Expect(st.Code()).To(Equal(codes.Unauthenticated))
	})

	t.Run("invalid_jwt", func(t *testing.T) {
		RegisterTestingT(t)
		ctx := metadata.AppendToOutgoingContext(context.Background(), "authorization", "Bearer not.a.jwt")

		_, err := projectClient.ListProjects(ctx, &pb.ListProjectsRequest{Page: 1, Size: 10})
		Expect(err).To(HaveOccurred())
		st, ok := status.FromError(err)
		Expect(ok).To(BeTrue())
		Expect(st.Code()).To(Equal(codes.Unauthenticated))
	})

	t.Run("forged_project_access", func(t *testing.T) {
		RegisterTestingT(t)
		userA := "forge-user-a"
		userB := "forge-user-b"
		testHelper.NewAccount(userA, "User A", "forgea@test.com")
		accountB := testHelper.NewAccount(userB, "User B", "forgeb@test.com")
		tokenB := testHelper.CreateJWTString(accountB)

		projA, _ := setupProjectWithRole(t, userA, "project:owner")
		setupProjectWithRole(t, userB, "project:viewer")

		sessInA := api.NewID()
		insertSession(t, sessInA, "forged-session", projA)

		resp, err := sessionClient.ListSessions(grpcCtx(tokenB), &pb.ListSessionsRequest{Page: 1, Size: 100})
		Expect(err).NotTo(HaveOccurred())

		for _, s := range resp.GetItems() {
			Expect(s.GetMetadata().GetId()).NotTo(Equal(sessInA),
				"userB must not see sessions from projA via gRPC list")
		}
	})
}
