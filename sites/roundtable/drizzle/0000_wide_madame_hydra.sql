CREATE TABLE `run_capabilities` (
	`user_id` text NOT NULL,
	`room_id` text NOT NULL,
	`run_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`lock_id` text,
	`locked_until` integer,
	PRIMARY KEY(`user_id`, `room_id`, `run_id`)
);
