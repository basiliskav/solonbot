#!/bin/bash
set -euo pipefail

BACKUP_INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"

# Writes a single backup to the given filename. Exits non-zero on failure so
# the caller can clean up the partial file.
run_backup() {
	local filename="$1"

	echo "[pg-backup] Starting backup: ${filename}"
	pg_dump | gzip >"${filename}"
	echo "[pg-backup] Backup complete: ${filename}"
}

prune_backups() {
	# Collect all backup files sorted by name (oldest first, since filenames are
	# ISO timestamps).
	local -a files
	mapfile -t files < <(find /backups -maxdepth 1 -name "solonbot-*.sql.gz" | sort)

	local total="${#files[@]}"
	if [[ "${total}" -eq 0 ]]; then
		return
	fi

	# The 24 most recent files are always kept (one per hour for a day).
	local hourly_keep=24
	local hourly_cutoff=$((total - hourly_keep))

	declare -A seen_years
	declare -A seen_months
	declare -A seen_days
	local daily_count=0
	local daily_limit=30
	local monthly_count=0
	local monthly_limit=12

	# Determine which files to keep. We iterate oldest-first so that the first
	# file seen for a given year/month/day is the oldest one for that period,
	# which is the one we want to keep as the representative snapshot.
	local -a keepers=()
	for ((i = 0; i < total; i++)); do
		local file="${files[$i]}"
		local basename
		basename=$(basename "${file}")
		# Extract the YYYY-MM-DD portion from solonbot-YYYY-MM-DDTHH-MM-SS.sql.gz.
		local date_part="${basename#solonbot-}"
		date_part="${date_part:0:10}"
		local year="${date_part:0:4}"
		local year_month="${date_part:0:7}"
		local year_month_day="${date_part}"

		local keep=false

		# Yearly rule: keep the first file seen for each year, forever.
		if [[ -z "${seen_years[$year]+_}" ]]; then
			seen_years[$year]=1
			keep=true
		fi

		# Monthly rule: keep the first file seen for each year-month, up to 12.
		# Yearly keepers don't consume a monthly slot.
		if [[ -z "${seen_months[$year_month]+_}" ]]; then
			seen_months[$year_month]=1
			if [[ "${keep}" == false && "${monthly_count}" -lt "${monthly_limit}" ]]; then
				monthly_count=$((monthly_count + 1))
				keep=true
			fi
		fi

		# Daily rule: keep the first file seen for each day, up to 30.
		# Yearly/monthly keepers don't consume a daily slot.
		if [[ -z "${seen_days[$year_month_day]+_}" ]]; then
			seen_days[$year_month_day]=1
			if [[ "${keep}" == false && "${daily_count}" -lt "${daily_limit}" ]]; then
				daily_count=$((daily_count + 1))
				keep=true
			fi
		fi

		# Hourly rule: the 24 most recent files are always kept.
		if [[ "${i}" -ge "${hourly_cutoff}" ]]; then
			keep=true
		fi

		if [[ "${keep}" == true ]]; then
			keepers+=("${file}")
		fi
	done

	# Delete any file that is not a keeper.
	for file in "${files[@]}"; do
		local is_keeper=false
		for keeper in "${keepers[@]}"; do
			if [[ "${file}" == "${keeper}" ]]; then
				is_keeper=true
				break
			fi
		done
		if [[ "${is_keeper}" == false ]]; then
			echo "[pg-backup] Deleting old backup: ${file}"
			rm -f "${file}"
		fi
	done
}

attempt_backup() {
	local timestamp
	timestamp=$(date -u +"%Y-%m-%dT%H-%M-%S")
	local filename="/backups/solonbot-${timestamp}.sql.gz"

	if ! run_backup "${filename}"; then
		echo "[pg-backup] ERROR: Backup failed; removing partial file if present"
		rm -f "${filename}"
	fi

	prune_backups
}

attempt_backup

while true; do
	sleep "${BACKUP_INTERVAL_SECONDS}"
	attempt_backup
done
