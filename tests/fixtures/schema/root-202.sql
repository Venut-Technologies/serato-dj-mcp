-- root.sqlite schema, dumped read-only from Serato DJ Lite 4.0.9 on 2026-09-14 (user_version 202).
-- The live file declares its triggers ON db1.<table>, because Serato creates it while attached as
-- db1. That text cannot be executed on a fresh database opened as main ("trigger cannot reference
-- objects in database db1"), so the qualifier is stripped here. On the real file opened as main the
-- triggers fire; tests/fixtures/make-root.test.ts checks this fixture reproduces that behaviour.
-- The statements below are the schema a Serato DJ Lite 4.x library creates
-- (schema version 202), reproduced so the tests exercise the real constraint
-- and trigger behaviour: UNIQUE(parent_id, name COLLATE NOCASE, type) on
-- container, the revision triggers on space, and the column defaults the
-- write path relies on. The vendor's own comments are not reproduced, the
-- database identifiers are synthetic, and no row of anyone's library is here:
-- tests insert every row they need.
CREATE VIEW serato_db AS SELECT X'22222222222222222222222222222222' AS uuid, 1 AS role;

CREATE TABLE serato
(
	database_name			TEXT DEFAULT '',
	time_created			INTEGER NOT NULL,
	time_last_connected		INTEGER DEFAULT NULL,
	last_master_uuid		BLOB DEFAULT NULL,
	revision				INT DEFAULT 0
);

CREATE TABLE master
(
	uuid					BLOB NOT NULL PRIMARY KEY,
	revision				INTEGER NOT NULL,
	last_sync_time			INTEGER NOT NULL,
	last_sync_secret		INTEGER NOT NULL
);

CREATE TABLE space
(
	id						INTEGER PRIMARY KEY,
	name					TEXT NOT NULL,
	revision				INTEGER NOT NULL DEFAULT 0,
	
	UNIQUE(name COLLATE NOCASE)
);

CREATE TABLE container
(
	id						INTEGER PRIMARY KEY AUTOINCREMENT,
	revision				INTEGER NOT NULL,
	parent_id				INTEGER,
	name					TEXT NOT NULL,
	type					INTEGER CHECK( type IS NOT NULL AND type >= 0 ) DEFAULT 1,
	list_order				INTEGER NOT NULL,
	space_id				INTEGER DEFAULT NULL,
	time_added				INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
	expanded				INTEGER NOT NULL DEFAULT 0,
	portable_id				TEXT NOT NULL DEFAULT '',
	color					INTEGER,
	
	UNIQUE(parent_id, name COLLATE NOCASE, type),
	FOREIGN KEY(parent_id) REFERENCES container(id) ON DELETE CASCADE,
	FOREIGN KEY(space_id) REFERENCES space(id) ON DELETE CASCADE
);

CREATE TABLE asset
(
	id							INTEGER PRIMARY KEY AUTOINCREMENT,
	revision					INTEGER NOT NULL,
	portable_id					TEXT NOT NULL DEFAULT '',
	file_name					TEXT DEFAULT NULL,
	file_size					INTEGER,
	file_bit_rate				REAL,
	file_sample_rate			REAL,
	type						TEXT NOT NULL DEFAULT '',
	format						TEXT NOT NULL DEFAULT '',
	artist						TEXT NOT NULL DEFAULT '',
	color						INTEGER,
	comments					TEXT NOT NULL DEFAULT '',
	comment_language			TEXT NOT NULL DEFAULT '',
	comment_descriptor			TEXT NOT NULL DEFAULT '',
	grouping					TEXT NOT NULL DEFAULT '',
	remixer						TEXT NOT NULL DEFAULT '',
	name						TEXT NOT NULL DEFAULT '',
	album						TEXT NOT NULL DEFAULT '',
	composer					TEXT NOT NULL DEFAULT '',
	year						TEXT NOT NULL DEFAULT '',
	genre						TEXT NOT NULL DEFAULT '',
	key							TEXT NOT NULL DEFAULT '',
	label						TEXT NOT NULL DEFAULT '',
	rating						REAL CHECK (rating IS NULL OR (rating BETWEEN 0 AND 1)),
	emoji						TEXT NOT NULL DEFAULT '',
	bpm							REAL,
	length_sec					INTEGER,
	length_ms					INTEGER,
	time_added					INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
	time_modified				INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
	part_of_set					TEXT NOT NULL DEFAULT '',
	track_number				TEXT NOT NULL DEFAULT '',
	video_portable_id			TEXT,
	is_corrupt					INTEGER NOT NULL DEFAULT 0,
	corrupt_description			TEXT,
	is_missing					INTEGER NOT NULL DEFAULT 0,
	is_readonly					INTEGER NOT NULL DEFAULT 0,
	is_beatgrid_locked			INTEGER NOT NULL DEFAULT 0,
	third_party_type			INTEGER CHECK( third_party_type IS NOT NULL AND third_party_type >= 0 ) DEFAULT 0,
	is_stale					INTEGER NOT NULL DEFAULT 0,
	is_whitelabel				INTEGER NOT NULL DEFAULT 0,
	is_karaoke					INTEGER NOT NULL DEFAULT 0,
	dj_play_count				INTEGER,
	dj_recently_played			INTEGER NOT NULL DEFAULT 0,
	analysis_flags				INTEGER NOT NULL DEFAULT 0,
	architectures				INTEGER NOT NULL DEFAULT 0,
	stems_analyze_state			INTEGER NOT NULL DEFAULT 0,
    type_specific_data			TEXT
);

CREATE TABLE space_asset
(
	id							INTEGER PRIMARY KEY,
	asset_id					INTEGER NOT NULL,
	space_id					INTEGER NOT NULL,
	
	UNIQUE(asset_id, space_id),
	FOREIGN KEY(asset_id) REFERENCES asset(id) ON DELETE CASCADE,
	FOREIGN KEY(space_id) REFERENCES space(id) ON DELETE CASCADE
);

CREATE TABLE container_asset
(
	id						INTEGER PRIMARY KEY AUTOINCREMENT,
	revision				INTEGER NOT NULL,
	container_id			INTEGER NOT NULL,
	space_asset_id			INTEGER NOT NULL,
	list_order				INTEGER DEFAULT NULL,
	time_added				INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
	FOREIGN KEY(container_id) REFERENCES container(id) ON DELETE CASCADE,
	FOREIGN KEY(space_asset_id) REFERENCES space_asset(id) ON DELETE CASCADE
);

CREATE TABLE asset_auxiliary
(
	asset_id					INTEGER NOT NULL,
	attribute					TEXT NOT NULL DEFAULT '',
	value						BLOB DEFAULT NULL,
	PRIMARY KEY(asset_id, attribute),
	FOREIGN KEY(asset_id) REFERENCES asset(id) ON DELETE CASCADE
);

CREATE TABLE dj_asset_metadata
(
	asset_id					INTEGER PRIMARY KEY,
	revision					INTEGER NOT NULL,
	video_effects				BLOB,
	batch_analysis_version		INTEGER,
	should_loop					INTEGER NOT NULL DEFAULT 0,
	is_itunes					INTEGER NOT NULL DEFAULT 0,
	itunes_id					TEXT,
	has_read_tags				INTEGER NOT NULL DEFAULT 0,
	is_whitelabel_acl			INTEGER NOT NULL DEFAULT 0,
	is_unsupported				INTEGER NOT NULL DEFAULT 0,
	external_id					INTEGER,
	
	FOREIGN KEY (asset_id) REFERENCES asset(id) ON DELETE CASCADE
);

CREATE TABLE dj_container_metadata
(
	container_id				INTEGER PRIMARY KEY,
	revision					INTEGER NOT NULL,
	export_state				INTEGER NOT NULL DEFAULT 0,
	filename					TEXT,
	
	FOREIGN KEY (container_id) REFERENCES container(id) ON DELETE CASCADE
);

CREATE TABLE migration_script
(
	from_schema_version			INTEGER,
	script_revision				INTEGER NOT NULL DEFAULT 1,
	pre_script					TEXT,
	migration					TEXT NOT NULL,
	post_script					TEXT,
	hash						TEXT NOT NULL,
	
	PRIMARY KEY(from_schema_version, script_revision)
);

CREATE TABLE last_seen_dbv2_library
(
	filename					TEXT NOT NULL PRIMARY KEY,
	size						INTEGER NOT NULL,
	md5_hash					BLOB NOT NULL
);

CREATE TABLE dbv2_status
(
	last_import_revision		INTEGER NOT NULL,
	last_import_time			INTEGER,
	last_export_revision		INTEGER NOT NULL,
	last_export_time			INTEGER,
	migrate_old_smart_crate		INTEGER NOT NULL DEFAULT 0,
	autosync_disabled			INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE smart_crate_rules
(
	container_id        INTEGER NOT NULL PRIMARY KEY,
	revision            INTEGER NOT NULL,
	version             INTEGER NOT NULL,
	rules               TEXT NOT NULL,
	needs_refresh       INTEGER NOT NULL DEFAULT 0,

	FOREIGN KEY( container_id ) REFERENCES container( id ) ON DELETE CASCADE
);

CREATE TABLE container_asset_list_columns
(
	container_id 			INTEGER,
	usage 					INTEGER,
	column_names 			TEXT NOT NULL,
	column_widths 			TEXT NOT NULL,
	primary_sort_column 	TEXT,
	primary_sort_direction 	INTEGER NOT NULL,
	migrated_by				INTEGER,

	PRIMARY KEY( container_id, usage ),
	FOREIGN KEY( container_id ) REFERENCES container( id ) ON DELETE CASCADE
);

CREATE UNIQUE INDEX asset__unique_portable_id ON asset ( portable_id COLLATE NOCASE );

CREATE INDEX space_asset__asset_id ON space_asset( asset_id );

CREATE INDEX container_asset__space_asset_id ON container_asset ( space_asset_id );

CREATE INDEX container_asset__container_space_asset_ids ON container_asset ( container_id, space_asset_id );

CREATE TRIGGER serato__singlerow
BEFORE INSERT ON serato
	WHEN (SELECT COUNT(*) FROM serato) >= 1
	BEGIN
		SELECT RAISE(FAIL, 'no way');
	END;

CREATE TRIGGER dbv2_status__singlerow
BEFORE INSERT ON dbv2_status
	WHEN (SELECT COUNT(*) FROM dbv2_status) >= 1
	BEGIN
		SELECT RAISE(FAIL, 'no way');
	END;

CREATE TRIGGER after_space_asset_delete
AFTER DELETE ON space_asset
	BEGIN
		DELETE FROM asset
		WHERE asset.id = old.asset_id
			AND NOT EXISTS( SELECT * FROM space_asset AS sa WHERE sa.asset_id = old.asset_id LIMIT 1 );
	END;

CREATE TRIGGER track_space_changes_when_asset_inserted
AFTER INSERT ON space_asset
	BEGIN
		UPDATE space
		SET revision = ( SELECT revision FROM serato )
		WHERE space.id = new.space_id
		AND space.revision < ( SELECT revision FROM serato );
	END;

CREATE TRIGGER track_space_changes_when_asset_removed
AFTER DELETE ON space_asset
	BEGIN
		UPDATE space
		SET revision = ( SELECT revision FROM serato )
		WHERE space.id = old.space_id
		AND space.revision < ( SELECT revision FROM serato );
	END;

CREATE TRIGGER track_space_changes_when_container_asset_inserted
AFTER INSERT ON container_asset
	BEGIN
		UPDATE space
		SET revision = ( SELECT revision FROM serato )
		WHERE space.id = (
			SELECT sa.space_id
			FROM space_asset sa
			WHERE sa.id = new.space_asset_id
		)
		AND space.revision < ( SELECT revision FROM serato );
	END;

CREATE TRIGGER track_space_changes_when_container_asset_removed
AFTER DELETE ON container_asset
	BEGIN
		UPDATE space
		SET revision = ( SELECT revision FROM serato )
		WHERE space.id = (
			SELECT sa.space_id
			FROM space_asset sa
			WHERE sa.id = old.space_asset_id
		)
		AND space.revision < ( SELECT revision FROM serato );
	END;

CREATE TRIGGER track_space_changes_when_container_added
AFTER INSERT ON container
	BEGIN
		UPDATE space
		SET revision = ( SELECT revision FROM serato )
		WHERE space.id = new.space_id
		AND new.parent_id <> 0
		AND space.revision < ( SELECT revision FROM serato );
	END;

CREATE TRIGGER track_space_changes_when_container_updated
AFTER UPDATE ON container
	BEGIN
		UPDATE space
		SET revision = ( SELECT revision FROM serato )
		WHERE space.id = new.space_id
		AND new.parent_id <> 0
		AND space.revision < ( SELECT revision FROM serato );
	END;

CREATE TRIGGER track_space_changes_when_container_removed
AFTER DELETE ON container
	BEGIN
		UPDATE space
		SET revision = ( SELECT revision FROM serato )
		WHERE space.id = old.space_id
		AND old.parent_id <> 0
		AND space.revision < ( SELECT revision FROM serato );
	END;

CREATE TRIGGER track_space_changes_when_smart_crate_rules_updated
AFTER UPDATE ON smart_crate_rules
	BEGIN
		UPDATE space
		SET revision = ( SELECT revision FROM serato )
		WHERE space.id = (
			SELECT c.space_id
			FROM container c
			WHERE c.id = new.container_id
		);
	END;
