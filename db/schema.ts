import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    locationLabel: text("location_label"),
    locationLat: real("location_lat"),
    locationLng: real("location_lng"),
    locationUpdatedAt: text("location_updated_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("idx_users_email").on(table.email)],
);

export const activities = sqliteTable(
  "activities",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull().references(() => users.id),
    sourceActivityId: text("source_activity_id"),
    organizerName: text("organizer_name").notNull(),
    organizerAvatar: text("organizer_avatar"),
    title: text("title").notNull(),
    category: text("category").notNull(),
    categoryName: text("category_name").notNull(),
    description: text("description").notNull(),
    lat: real("lat").notNull(),
    lng: real("lng").notNull(),
    placeName: text("place_name"),
    address: text("address"),
    adcode: text("adcode"),
    locationSource: text("location_source"),
    area: text("area").notNull(),
    budgetMax: integer("budget_max").notNull(),
    budget: text("budget").notNull(),
    time: text("time").notNull(),
    shortTime: text("short_time").notNull(),
    people: text("people").notNull(),
    weather: text("weather").notNull(),
    organizerContactType: text("organizer_contact_type"),
    organizerContactValue: text("organizer_contact_value"),
    isRecurring: integer("is_recurring", { mode: "boolean" }).notNull().default(false),
    genderPolicy: text("gender_policy").notNull().default("any"),
    minPeople: integer("min_people").notNull().default(2),
    maxPeople: integer("max_people").notNull().default(6),
    applicationDeadline: text("application_deadline"),
    endsAt: text("ends_at"),
    status: text("status").notNull(),
    reviewNote: text("review_note"),
    reviewedAt: text("reviewed_at"),
    reviewedBy: text("reviewed_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_activities_status_created").on(table.status, table.createdAt),
    index("idx_activities_owner").on(table.ownerUserId),
    index("idx_activities_source").on(table.sourceActivityId),
  ],
);

export const weekendPlans = sqliteTable(
  "weekend_plans",
  {
    userId: text("user_id").notNull().references(() => users.id),
    activityId: text("activity_id").notNull(),
    status: text("status").notNull(),
    teammateNamesJson: text("teammate_names_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.activityId] }),
    index("idx_weekend_plans_user_status").on(table.userId, table.status),
  ],
);

export const registrations = sqliteTable(
  "registrations",
  {
    userId: text("user_id").notNull().references(() => users.id),
    activityId: text("activity_id").notNull(),
    intent: text("intent").notNull(),
    contactType: text("contact_type").notNull().default("other"),
    contactValue: text("contact_value").notNull().default(""),
    applicantGender: text("applicant_gender").notNull().default("undisclosed"),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.activityId] }),
    index("idx_registrations_activity_status").on(table.activityId, table.status),
  ],
);

export const reviews = sqliteTable(
  "reviews",
  {
    userId: text("user_id").notNull().references(() => users.id),
    activityId: text("activity_id").notNull(),
    rating: integer("rating").notNull(),
    review: text("review").notNull(),
    tagsJson: text("tags_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.activityId] }),
    index("idx_reviews_activity").on(table.activityId),
  ],
);

export const adminAuditLogs = sqliteTable(
  "admin_audit_logs",
  {
    id: text("id").primaryKey(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    detail: text("detail").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_admin_audit_created").on(table.createdAt),
    index("idx_admin_audit_target").on(table.targetType, table.targetId),
  ],
);

export const travelSharedTrips = sqliteTable(
  "travel_shared_trips",
  {
    id: text("id").primaryKey(),
    snapshotJson: text("snapshot_json").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [index("idx_travel_shared_trips_expires").on(table.expiresAt)],
);

// A browser visit owns separate intent and planning Agent Sessions. The legacy
// session_id remains the intent Session so existing visit calls keep working.
// Only a SHA-256 digest of the random tab token is persisted; Bailian Session
// IDs stay server-side.
export const travelAgentVisits = sqliteTable(
  "travel_agent_visits",
  {
    tokenHash: text("token_hash").primaryKey(),
    sessionId: text("session_id"),
    planningSessionId: text("planning_session_id"),
    planningIntentVersion: integer("planning_intent_version"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at"),
    createdAt: integer("created_at").notNull(),
    lastActiveAt: integer("last_active_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("idx_travel_agent_visits_expires").on(table.expiresAt)],
);

// The handoff is an explicit, compact snapshot of confirmed intent. It is
// authoritative for the planning Session and never stores the chat history.
export const travelPlanningHandoffs = sqliteTable(
  "travel_planning_handoffs",
  {
    tokenHash: text("token_hash").primaryKey(),
    handoffId: text("handoff_id").notNull(),
    sourceIntentStateVersion: integer("source_intent_state_version").notNull(),
    handoffJson: text("handoff_json").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_travel_planning_handoffs_updated").on(table.updatedAt)],
);

export const travelPlanningDrafts = sqliteTable(
  "travel_planning_drafts",
  {
    tokenHash: text("token_hash").primaryKey(),
    version: integer("version").notNull(),
    handoffId: text("handoff_id").notNull(),
    sourceIntentStateVersion: integer("source_intent_state_version").notNull(),
    draftJson: text("draft_json").notNull(),
    lastTurnId: text("last_turn_id"),
    lastInputHash: text("last_input_hash"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_travel_planning_drafts_updated").on(table.updatedAt)],
);

export const travelPlanningDraftTurns = sqliteTable(
  "travel_planning_draft_turns",
  {
    tokenHash: text("token_hash").notNull(),
    turnId: text("turn_id").notNull(),
    inputHash: text("input_hash").notNull(),
    draftVersion: integer("draft_version").notNull(),
    responseJson: text("response_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tokenHash, table.turnId] }),
    index("idx_travel_planning_draft_turns_created").on(table.createdAt),
  ],
);

export const travelAgentTurns = sqliteTable(
  "travel_agent_turns",
  {
    tokenHash: text("token_hash").notNull(),
    turnId: text("turn_id").notNull(),
    sessionId: text("session_id").notNull(),
    inputHash: text("input_hash").notNull(),
    status: text("status").notNull(),
    inputEventId: text("input_event_id"),
    inputCreatedAt: text("input_created_at"),
    replyText: text("reply_text"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tokenHash, table.turnId] }),
    index("idx_travel_agent_turns_created").on(table.createdAt),
  ],
);

// The latest accepted intent is authoritative for one browser visit. A
// completed turn is recorded separately so a retry can return its exact prior
// response without applying its patch twice.
export const travelIntentStates = sqliteTable(
  "travel_intent_states",
  {
    tokenHash: text("token_hash").primaryKey(),
    stateVersion: integer("state_version").notNull(),
    resultJson: text("result_json"),
    slotMetaJson: text("slot_meta_json").notNull(),
    lastTurnId: text("last_turn_id"),
    lastInputHash: text("last_input_hash"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_travel_intent_states_updated").on(table.updatedAt)],
);

export const travelIntentTurns = sqliteTable(
  "travel_intent_turns",
  {
    tokenHash: text("token_hash").notNull(),
    turnId: text("turn_id").notNull(),
    inputHash: text("input_hash").notNull(),
    stateVersion: integer("state_version").notNull(),
    responseJson: text("response_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tokenHash, table.turnId] }),
    index("idx_travel_intent_turns_created").on(table.createdAt),
  ],
);

// Query jobs hold server-only Agent turn references indirectly through turn_id.
// The browser receives only a small status projection from the planning draft.
export const travelPlanningFlightJobs = sqliteTable(
  "travel_planning_flight_jobs",
  {
    tokenHash: text("token_hash").notNull(),
    jobId: text("job_id").notNull(),
    handoffId: text("handoff_id").notNull(),
    sourceIntentStateVersion: integer("source_intent_state_version").notNull(),
    inputHash: text("input_hash").notNull(),
    queryJson: text("query_json").notNull(),
    status: text("status").notNull(),
    resultJson: text("result_json"),
    errorCode: text("error_code"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deadlineAt: integer("deadline_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.tokenHash, table.jobId] }), index("idx_travel_flight_jobs_updated").on(table.updatedAt)],
);

export const travelPlanningHotelJobs = sqliteTable(
  "travel_planning_hotel_jobs",
  {
    tokenHash: text("token_hash").notNull(),
    jobId: text("job_id").notNull(),
    handoffId: text("handoff_id").notNull(),
    sourceIntentStateVersion: integer("source_intent_state_version").notNull(),
    inputHash: text("input_hash").notNull(),
    queryJson: text("query_json").notNull(),
    status: text("status").notNull(),
    resultJson: text("result_json"),
    errorCode: text("error_code"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deadlineAt: integer("deadline_at").notNull(),
    pollOwner: text("poll_owner"),
    pollExpiresAt: integer("poll_expires_at"),
  },
  (table) => [primaryKey({ columns: [table.tokenHash, table.jobId] }), index("idx_travel_hotel_jobs_updated").on(table.updatedAt)],
);

// Agent turns serialize independently of short planning-data transactions.
export const travelPlanningAgentLocks = sqliteTable(
  "travel_planning_agent_locks",
  {
    tokenHash: text("token_hash").primaryKey(),
    owner: text("owner").notNull(),
    expiresAt: integer("expires_at").notNull(),
    visitCreatedAt: integer("visit_created_at").notNull(),
  },
);

export const travelPlanningSceneJobs = sqliteTable(
  "travel_planning_scene_jobs",
  {
    tokenHash: text("token_hash").notNull(),
    jobId: text("job_id").notNull(),
    handoffId: text("handoff_id").notNull(),
    sourceIntentStateVersion: integer("source_intent_state_version").notNull(),
    inputHash: text("input_hash").notNull(),
    queryJson: text("query_json").notNull(),
    status: text("status").notNull(),
    resultJson: text("result_json").notNull(),
    errorCode: text("error_code"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deadlineAt: integer("deadline_at").notNull(),
    pollOwner: text("poll_owner"),
    pollExpiresAt: integer("poll_expires_at"),
  },
  (table) => [primaryKey({ columns: [table.tokenHash, table.jobId] }), index("idx_travel_scene_jobs_updated").on(table.updatedAt)],
);

export const travelPlanningHelpSessions = sqliteTable(
  "travel_planning_help_sessions",
  {
    tokenHash: text("token_hash").notNull(),
    handoffId: text("handoff_id").notNull(),
    visitCreatedAt: integer("visit_created_at").notNull(),
    sessionId: text("session_id"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.tokenHash, table.handoffId, table.visitCreatedAt] }), index("idx_travel_help_sessions_updated").on(table.updatedAt)],
);
