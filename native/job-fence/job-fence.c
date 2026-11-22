// seira-job-fence: keeps the memory of all bot work under one limit on Windows, with one job object per server.
//
//   seira-job-fence.exe hold <job base name> <limit MiB>
//     Creates the bots job "<base>-<own pid>" with that memory limit and stays running. It prints one JSON object per
//     line on stdout: "ready" (with the job name), "limit", "stats", "memory-stop", "memory-denied" and "error". It reads
//     "limit <MiB>" and "stats" lines on stdin, and exits when stdin closes (the server stopped).
//
//   seira-job-fence.exe -- <program> [arguments]
//     Starts the program inside the job that SEIRA_FENCE_JOB names, waits for it, and exits with its exit code. The
//     program gets this process's stdin, stdout, stderr and environment (without SEIRA_FENCE_JOB) and the command line
//     after "--" exactly as written. The program also gets a job of its own inside the bots job: when this helper is
//     stopped, the program and its children stop with it. When the bots job is missing, the program runs without it.
//     When the bots job exists but the program cannot start inside it, the program does not run and the exit code is
//     127. A bare program name is looked up on PATH only, and a .bat or .cmd file is never started.
//
// Near the limit, and when the job refuses an allocation, "hold" stops the largest process in the job that is not an
// engine (a process the "--" mode started), else the largest engine, with exit code 137 as on Linux.
#define WIN32_LEAN_AND_MEAN
#define PSAPI_VERSION 2
// C99 printf (%llu) whatever C runtime the toolchain targets.
#define __USE_MINGW_ANSI_STDIO 1
#include <windows.h>
#include <psapi.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#ifndef PROC_THREAD_ATTRIBUTE_JOB_LIST
#define PROC_THREAD_ATTRIBUTE_JOB_LIST ProcThreadAttributeValue(13, FALSE, TRUE, FALSE)
#endif

#ifndef JOB_OBJECT_MSG_NOTIFICATION_LIMIT
#define JOB_OBJECT_MSG_NOTIFICATION_LIMIT 11
#endif

// JOBOBJECT_NOTIFICATION_LIMIT_INFORMATION (Windows 8), under its own name: older MinGW-w64 headers do not have it.
typedef struct {
  DWORD64 IoReadBytesLimit;
  DWORD64 IoWriteBytesLimit;
  LARGE_INTEGER PerJobUserTimeLimit;
  DWORD64 JobMemoryLimit;
  DWORD RateControlTolerance;
  DWORD RateControlToleranceInterval;
  DWORD LimitFlags;
} NotificationLimit;
#define JOB_NOTIFICATION_LIMIT_CLASS ((JOBOBJECTINFOCLASS)12)

#define STOPPED_EXIT_CODE 137
#define START_FAILED_EXIT_CODE 127
#define USAGE_EXIT_CODE 2
#define JOB_KEY 1
#define QUIT_KEY 2
// The job memory limit refuses the allocation, and the program that asked (often the engine) then fails on its own. A
// notification at this share of the limit lets "hold" stop a process before the refusal.
#define NOTIFY_PERCENT 90
#define NOTIFY_STOP_AT_PERCENT 85
// A refused allocation stops a process only when the job is this full: a single large request can fail with room left.
#define STOP_AT_PERCENT 90
// After a notification or a refusal the job is checked every second for this long, for programs that keep growing. A
// refusal can come only once, while the program that asked keeps trying.
#define PRESSURE_MS 30000
#define SWEEP_MS 1000
// The largest limit in MiB whose byte count fits in a signed 64-bit number.
#define MAX_LIMIT_MIB ((~0ULL >> 1) >> 20)

static const wchar_t FENCE_ENV[] = L"SEIRA_FENCE_JOB";

// ---- output ----

static CRITICAL_SECTION out_lock;

static void write_line(const char *line) {
  EnterCriticalSection(&out_lock);
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  DWORD wrote = 0;
  WriteFile(out, line, (DWORD)strlen(line), &wrote, NULL);
  WriteFile(out, "\n", 1, &wrote, NULL);
  LeaveCriticalSection(&out_lock);
}

// JSON string body of a UTF-16 text: UTF-8, with quotes, backslashes and control characters escaped.
static void json_text(const wchar_t *text, char *out, size_t size) {
  char utf8[3 * MAX_PATH + 1];
  int n = WideCharToMultiByte(CP_UTF8, 0, text, -1, utf8, (int)sizeof utf8, NULL, NULL);
  if (n <= 0) utf8[0] = 0;
  size_t used = 0;
  for (const unsigned char *p = (const unsigned char *)utf8; *p && used + 7 < size; p++) {
    if (*p == '"' || *p == '\\') { out[used++] = '\\'; out[used++] = (char)*p; }
    else if (*p < 0x20) used += (size_t)snprintf(out + used, size - used, "\\u%04x", *p);
    else out[used++] = (char)*p;
  }
  out[used] = 0;
}

static void write_error(const char *step, DWORD code) {
  char line[160];
  snprintf(line, sizeof line, "{\"event\":\"error\",\"step\":\"%s\",\"code\":%lu}", step, (unsigned long)code);
  write_line(line);
}

// ---- the job's processes ----

typedef struct {
  DWORD pid;
  DWORD ppid;
  ULONGLONG bytes;
  int skip;
  wchar_t name[MAX_PATH];
} Proc;

typedef struct {
  Proc *all;
  DWORD all_count;
  DWORD *in_job;
  DWORD job_count;
  ULONGLONG job_bytes;
} Look;

static wchar_t self_name[MAX_PATH];

static void free_look(Look *look) {
  free(look->all);
  free(look->in_job);
  memset(look, 0, sizeof *look);
}

static Proc *find_proc(const Look *look, DWORD pid) {
  for (DWORD i = 0; i < look->all_count; i++) if (look->all[i].pid == pid) return &look->all[i];
  return NULL;
}

static int is_in_job(const Look *look, DWORD pid) {
  for (DWORD i = 0; i < look->job_count; i++) if (look->in_job[i] == pid) return 1;
  return 0;
}

// Private (committed) bytes: what the job's memory limit counts.
static ULONGLONG private_bytes(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, FALSE, pid);
  if (!process) process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return 0;
  PROCESS_MEMORY_COUNTERS_EX counters;
  memset(&counters, 0, sizeof counters);
  counters.cb = sizeof counters;
  ULONGLONG bytes = GetProcessMemoryInfo(process, (PROCESS_MEMORY_COUNTERS *)&counters, sizeof counters) ? counters.PrivateUsage : 0;
  CloseHandle(process);
  return bytes;
}

static int take_look(HANDLE job, Look *look) {
  memset(look, 0, sizeof *look);
  DWORD capacity = 64;
  JOBOBJECT_BASIC_PROCESS_ID_LIST *list = NULL;
  for (;;) {
    DWORD size = (DWORD)(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + (capacity - 1) * sizeof(ULONG_PTR));
    list = (JOBOBJECT_BASIC_PROCESS_ID_LIST *)calloc(1, size);
    if (!list) return 0;
    if (QueryInformationJobObject(job, JobObjectBasicProcessIdList, list, size, NULL)) break;
    DWORD needed = list->NumberOfAssignedProcesses;
    DWORD error = GetLastError();
    free(list);
    list = NULL;
    if (error != ERROR_MORE_DATA || needed < capacity || capacity > 65536) return 0;
    capacity = needed + 32;
  }
  look->job_count = list->NumberOfProcessIdsInList;
  look->in_job = (DWORD *)calloc(look->job_count ? look->job_count : 1, sizeof(DWORD));
  if (!look->in_job) { free(list); return 0; }
  for (DWORD i = 0; i < look->job_count; i++) look->in_job[i] = (DWORD)list->ProcessIdList[i];
  free(list);

  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return 1;
  DWORD capacity_all = 512;
  look->all = (Proc *)calloc(capacity_all, sizeof(Proc));
  PROCESSENTRY32W entry;
  entry.dwSize = sizeof entry;
  for (BOOL more = Process32FirstW(snapshot, &entry); more && look->all; more = Process32NextW(snapshot, &entry)) {
    if (look->all_count == capacity_all) {
      Proc *grown = (Proc *)realloc(look->all, 2 * capacity_all * sizeof(Proc));
      if (!grown) break;
      look->all = grown;
      capacity_all *= 2;
    }
    Proc *proc = &look->all[look->all_count++];
    memset(proc, 0, sizeof *proc);
    proc->pid = entry.th32ProcessID;
    proc->ppid = entry.th32ParentProcessID;
    wcsncpy(proc->name, entry.szExeFile, MAX_PATH - 1);
  }
  CloseHandle(snapshot);
  for (DWORD i = 0; i < look->all_count; i++) {
    Proc *proc = &look->all[i];
    if (!is_in_job(look, proc->pid)) continue;
    proc->bytes = private_bytes(proc->pid);
    look->job_bytes += proc->bytes;
  }
  return 1;
}

// An engine: a process in the job whose parent is a "--" helper, which is outside the job.
static int is_engine(const Look *look, const Proc *proc) {
  if (is_in_job(look, proc->ppid)) return 0;
  const Proc *parent = find_proc(look, proc->ppid);
  return parent != NULL && _wcsicmp(parent->name, self_name) == 0;
}

// The process at the top of its tree inside the job.
static const Proc *tree_root(const Look *look, const Proc *proc) {
  for (int depth = 0; depth < 64; depth++) {
    if (!is_in_job(look, proc->ppid) || proc->ppid == proc->pid) return proc;
    const Proc *parent = find_proc(look, proc->ppid);
    if (!parent) return proc;
    proc = parent;
  }
  return proc;
}

// ---- hold ----

typedef struct {
  HANDLE job;
  HANDLE port;
  volatile LONGLONG limit;
  wchar_t name[300];
} Hold;

// Arms (again) the notification at NOTIFY_PERCENT of the limit. Without it the limit still holds; only the early stop is lost.
static void arm_notification(Hold *hold) {
  NotificationLimit info;
  memset(&info, 0, sizeof info);
  info.LimitFlags = JOB_OBJECT_LIMIT_JOB_MEMORY;
  info.JobMemoryLimit = (ULONGLONG)hold->limit / 100 * NOTIFY_PERCENT;
  if (!SetInformationJobObject(hold->job, JOB_NOTIFICATION_LIMIT_CLASS, &info, sizeof info)) write_error("notify", GetLastError());
}

static int set_limit(Hold *hold, ULONGLONG bytes) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION info;
  memset(&info, 0, sizeof info);
  info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_JOB_MEMORY;
  info.JobMemoryLimit = (SIZE_T)bytes;
  if (!SetInformationJobObject(hold->job, JobObjectExtendedLimitInformation, &info, sizeof info)) return 0;
  InterlockedExchange64(&hold->limit, (LONGLONG)bytes);
  arm_notification(hold);
  return 1;
}

// A limit in MiB: digits only (no sign, no space), from 1 to MAX_LIMIT_MIB. 0 when the text is not one.
static ULONGLONG parse_mib(const char *text) {
  if (*text < '0' || *text > '9') return 0;
  char *end = NULL;
  unsigned long long mib = strtoull(text, &end, 10);
  if (!end || *end != 0 || mib > MAX_LIMIT_MIB) return 0;
  return mib;
}

// The largest process in the job that is not skipped: one that is not an engine first, else an engine. Windows puts the
// console host of a console program in the program's job; stopping it frees nothing.
static Proc *pick_target(Look *look) {
  Proc *target = NULL;
  for (int pass = 0; pass < 2 && !target; pass++) {
    for (DWORD i = 0; i < look->all_count; i++) {
      Proc *proc = &look->all[i];
      if (proc->skip || !is_in_job(look, proc->pid) || proc->pid == GetCurrentProcessId()) continue;
      if (_wcsicmp(proc->name, L"conhost.exe") == 0) continue;
      if (pass == 0 && is_engine(look, proc)) continue;
      if (!target || proc->bytes > target->bytes) target = proc;
    }
  }
  return target;
}

static ULONGLONG job_bytes_now(Hold *hold) {
  Look look;
  if (!take_look(hold->job, &look)) return 0;
  ULONGLONG bytes = look.job_bytes;
  free_look(&look);
  return bytes;
}

static void stop_largest(Hold *hold, DWORD by, int percent, int report_denied) {
  Look look;
  if (!take_look(hold->job, &look)) { write_error("look", GetLastError()); return; }
  ULONGLONG limit = (ULONGLONG)hold->limit;
  if (look.job_bytes * 100 < limit * (ULONGLONG)percent) {
    if (report_denied) {
      char line[200];
      snprintf(line, sizeof line, "{\"event\":\"memory-denied\",\"by\":%lu,\"jobBytes\":%llu,\"limitBytes\":%llu}",
        (unsigned long)by, look.job_bytes, limit);
      write_line(line);
    }
    free_look(&look);
    return;
  }
  Proc *target = NULL;
  HANDLE process = NULL;
  // A pid from the list can belong to a new process by now: stop it only while it is still in this job.
  for (int tries = 0; tries < 8 && !process; tries++) {
    target = pick_target(&look);
    if (!target) break;
    process = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, target->pid);
    BOOL in = FALSE;
    if (process && (!IsProcessInJob(process, hold->job, &in) || !in)) { CloseHandle(process); process = NULL; }
    if (!process) target->skip = 1;
  }
  if (!target || !process) { free_look(&look); return; }
  const Proc *root = tree_root(&look, target);
  DWORD helper = is_engine(&look, root) ? root->ppid : 0;
  int stopped = TerminateProcess(process, STOPPED_EXIT_CODE);
  DWORD error = stopped ? 0 : GetLastError();
  char name[3 * MAX_PATH + 1];
  json_text(target->name, name, sizeof name);
  char line[1200];
  if (stopped)
    snprintf(line, sizeof line,
      "{\"event\":\"memory-stop\",\"pid\":%lu,\"name\":\"%s\",\"bytes\":%llu,\"jobBytes\":%llu,\"limitBytes\":%llu,\"root\":%lu,\"helper\":%lu,\"by\":%lu}",
      (unsigned long)target->pid, name, target->bytes, look.job_bytes, limit, (unsigned long)root->pid, (unsigned long)helper, (unsigned long)by);
  else
    snprintf(line, sizeof line, "{\"event\":\"error\",\"step\":\"stop\",\"code\":%lu,\"pid\":%lu}", (unsigned long)error, (unsigned long)target->pid);
  // Before the wait: a stopped engine ends its turn at once, and the server counts the stop for that turn.
  write_line(line);
  // Wait for its memory to come back, so the next message does not count it again.
  if (stopped) WaitForSingleObject(process, 2000);
  CloseHandle(process);
  free_look(&look);
}

static void write_stats(Hold *hold) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION info;
  memset(&info, 0, sizeof info);
  ULONGLONG peak = QueryInformationJobObject(hold->job, JobObjectExtendedLimitInformation, &info, sizeof info, NULL) ? info.PeakJobMemoryUsed : 0;
  Look look;
  int seen = take_look(hold->job, &look);
  char line[240];
  snprintf(line, sizeof line, "{\"event\":\"stats\",\"processes\":%lu,\"jobBytes\":%llu,\"peakBytes\":%llu,\"limitBytes\":%llu}",
    (unsigned long)(seen ? look.job_count : 0), seen ? look.job_bytes : 0ULL, peak, (ULONGLONG)hold->limit);
  write_line(line);
  if (seen) free_look(&look);
}

static void run_command(Hold *hold, char *line) {
  size_t len = strlen(line);
  while (len && (line[len - 1] == '\r' || line[len - 1] == ' ')) line[--len] = 0;
  if (strncmp(line, "limit ", 6) == 0) {
    ULONGLONG mib = parse_mib(line + 6);
    if (mib == 0) { write_error("limit-value", 0); return; }
    if (!set_limit(hold, mib << 20)) { write_error("limit", GetLastError()); return; }
    char out[96];
    snprintf(out, sizeof out, "{\"event\":\"limit\",\"limitBytes\":%llu}", mib << 20);
    write_line(out);
  } else if (strcmp(line, "stats") == 0) {
    write_stats(hold);
  } else if (len) {
    write_error("command", 0);
  }
}

static DWORD WINAPI read_commands(LPVOID arg) {
  Hold *hold = (Hold *)arg;
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  char buffer[512];
  size_t used = 0;
  for (;;) {
    DWORD got = 0;
    if (!ReadFile(in, buffer + used, (DWORD)(sizeof buffer - 1 - used), &got, NULL) || got == 0) break;
    used += got;
    buffer[used] = 0;
    char *start = buffer;
    for (char *newline; (newline = strchr(start, '\n')) != NULL; start = newline + 1) {
      *newline = 0;
      run_command(hold, start);
    }
    used = (size_t)(buffer + used - start);
    memmove(buffer, start, used);
    // A line longer than the buffer is not a command: drop it.
    if (used == sizeof buffer - 1) used = 0;
  }
  PostQueuedCompletionStatus(hold->port, 0, QUIT_KEY, NULL);
  return 0;
}

static int hold_main(const wchar_t *base, const wchar_t *limit_text) {
  char limit_ascii[32];
  ULONGLONG mib = 0;
  if (wcslen(limit_text) < sizeof limit_ascii) {
    size_t i = 0;
    for (; limit_text[i]; i++) limit_ascii[i] = limit_text[i] < 128 ? (char)limit_text[i] : '?';
    limit_ascii[i] = 0;
    mib = parse_mib(limit_ascii);
  }
  if (mib == 0 || wcslen(base) > 200) {
    fputs("usage: seira-job-fence hold <job base name> <limit MiB>\n", stderr);
    return USAGE_EXIT_CODE;
  }
  static Hold hold;
  // A new job each time: a job keeps the first completion port it gets, so a job from an earlier server cannot report here.
  swprintf(hold.name, sizeof hold.name / sizeof hold.name[0], L"%ls-%lu", base, (unsigned long)GetCurrentProcessId());
  SetLastError(ERROR_SUCCESS);
  hold.job = CreateJobObjectW(NULL, hold.name);
  if (!hold.job) { write_error("create", GetLastError()); return 1; }
  // An existing job of that name belongs to another process, and its limit and port are not ours to set.
  if (GetLastError() == ERROR_ALREADY_EXISTS) { write_error("exists", ERROR_ALREADY_EXISTS); CloseHandle(hold.job); return 1; }
  if (!set_limit(&hold, mib << 20)) { write_error("limit", GetLastError()); return 1; }
  hold.port = CreateIoCompletionPort(INVALID_HANDLE_VALUE, NULL, 0, 1);
  if (!hold.port) { write_error("port", GetLastError()); return 1; }
  JOBOBJECT_ASSOCIATE_COMPLETION_PORT link;
  link.CompletionKey = (PVOID)(ULONG_PTR)JOB_KEY;
  link.CompletionPort = hold.port;
  if (!SetInformationJobObject(hold.job, JobObjectAssociateCompletionPortInformation, &link, sizeof link)) {
    write_error("port", GetLastError());
    return 1;
  }
  HANDLE reader = CreateThread(NULL, 0, read_commands, &hold, 0, NULL);
  if (!reader) { write_error("thread", GetLastError()); return 1; }
  CloseHandle(reader);

  char name[700];
  json_text(hold.name, name, sizeof name);
  char line[900];
  snprintf(line, sizeof line, "{\"event\":\"ready\",\"job\":\"%s\",\"limitBytes\":%llu,\"pid\":%lu}", name, mib << 20,
    (unsigned long)GetCurrentProcessId());
  write_line(line);

  ULONGLONG pressure_until = 0, last_sweep = 0;
  int notified = 0;
  for (;;) {
    DWORD message = 0;
    ULONG_PTR key = 0;
    LPOVERLAPPED value = NULL;
    ULONGLONG now = GetTickCount64();
    DWORD wait = INFINITE;
    if (now < pressure_until) wait = now - last_sweep >= SWEEP_MS ? 0 : (DWORD)(SWEEP_MS - (now - last_sweep));
    BOOL got = GetQueuedCompletionStatus(hold.port, &message, &key, &value, wait);
    if (!got && value == NULL && GetLastError() != WAIT_TIMEOUT) break;
    if (got && key == QUIT_KEY) break;
    if (got && key == JOB_KEY && message == JOB_OBJECT_MSG_NOTIFICATION_LIMIT) {
      stop_largest(&hold, (DWORD)(ULONG_PTR)value, NOTIFY_STOP_AT_PERCENT, 0);
      notified = 1;
      pressure_until = GetTickCount64() + PRESSURE_MS;
    } else if (got && key == JOB_KEY && message == JOB_OBJECT_MSG_JOB_MEMORY_LIMIT) {
      stop_largest(&hold, (DWORD)(ULONG_PTR)value, STOP_AT_PERCENT, 1);
      pressure_until = GetTickCount64() + PRESSURE_MS;
    }
    // By time, not by timeout: other job messages (a process starts or ends) must not hold the sweep back.
    now = GetTickCount64();
    if (now < pressure_until && now - last_sweep >= SWEEP_MS) {
      last_sweep = now;
      stop_largest(&hold, 0, STOP_AT_PERCENT, 0);
      // The notification may come once per crossing: arm it again once the job is back under the stop line.
      if (notified && job_bytes_now(&hold) * 100 < (ULONGLONG)hold.limit * NOTIFY_STOP_AT_PERCENT) { arm_notification(&hold); notified = 0; }
    }
  }
  // The job lives on while its programs run: they keep the limit after this process ends.
  CloseHandle(hold.job);
  return 0;
}

// ---- -- <program> ----

static BOOL WINAPI keep_waiting(DWORD event) {
  // Ctrl+C reaches the program too; this process waits for the program to end and passes its exit code on.
  return event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT;
}

static const wchar_t *skip_space(const wchar_t *p) {
  while (*p == L' ' || *p == L'\t') p++;
  return p;
}

// The program name follows simpler rules than the other arguments: quotes delimit it and backslashes are literal.
static const wchar_t *skip_program_name(const wchar_t *p) {
  if (*p == L'"') {
    p++;
    while (*p && *p != L'"') p++;
    if (*p) p++;
  } else {
    while (*p && *p != L' ' && *p != L'\t') p++;
  }
  return p;
}

static void inherit(HANDLE handle) {
  if (handle && handle != INVALID_HANDLE_VALUE) SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
}

// The program name as CreateProcess reads it: quotes delimit it and backslashes are literal.
static wchar_t *program_token(const wchar_t *tail) {
  const wchar_t *start = tail;
  if (*tail == L'"') start++;
  const wchar_t *end = skip_program_name(tail);
  if (*tail == L'"' && end > start && end[-1] == L'"') end--;
  size_t length = end > start ? (size_t)(end - start) : 0;
  wchar_t *token = (wchar_t *)calloc(length + 1, sizeof(wchar_t));
  if (token) memcpy(token, start, length * sizeof(wchar_t));
  return token;
}

// CreateProcess runs a .bat or .cmd file through cmd.exe, which parses the arguments again by other rules
// (CVE-2024-27980). Windows drops trailing dots and spaces from a file name, and a colon in the last part names a stream.
static int is_refused(const wchar_t *path) {
  const wchar_t *last = path;
  for (const wchar_t *p = path; *p; p++) if (*p == L'\\' || *p == L'/') last = p + 1;
  if (wcschr(last, L':')) return 1;
  size_t n = wcslen(last);
  while (n && (last[n - 1] == L'.' || last[n - 1] == L' ')) n--;
  return n >= 4 && (_wcsnicmp(last + n - 4, L".bat", 4) == 0 || _wcsnicmp(last + n - 4, L".cmd", 4) == 0);
}

static int is_file(const wchar_t *path) {
  DWORD attributes = GetFileAttributesW(path);
  return attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_DIRECTORY);
}

#define PATH_CHARS 32768

// The program file: a path as written, else with ".exe" added; a bare name from PATH only, so the folder of this
// helper and the current folder never supply a program.
static wchar_t *resolve_program(const wchar_t *token) {
  if (!*token) return NULL;
  wchar_t *path = (wchar_t *)calloc(PATH_CHARS + 8, sizeof(wchar_t));
  if (!path) return NULL;
  DWORD n = 0;
  if (wcspbrk(token, L"\\/:")) {
    n = GetFullPathNameW(token, PATH_CHARS, path, NULL);
    if (n > 0 && n < PATH_CHARS && !is_file(path)) wcscat(path, L".exe");
  } else {
    DWORD size = GetEnvironmentVariableW(L"PATH", NULL, 0);
    wchar_t *folders = size ? (wchar_t *)calloc(size, sizeof(wchar_t)) : NULL;
    if (folders && GetEnvironmentVariableW(L"PATH", folders, size)) n = SearchPathW(folders, token, L".exe", PATH_CHARS, path, NULL);
    free(folders);
  }
  if (n == 0 || n >= PATH_CHARS || !is_file(path)) { free(path); return NULL; }
  return path;
}

static int run_main(void) {
  const wchar_t *p = skip_space(skip_program_name(GetCommandLineW()));
  if (!(p[0] == L'-' && p[1] == L'-' && (p[2] == L' ' || p[2] == L'\t'))) {
    fputs("usage: seira-job-fence -- <program> [arguments]\n", stderr);
    return USAGE_EXIT_CODE;
  }
  const wchar_t *tail = skip_space(p + 2);
  if (!*tail) {
    fputs("usage: seira-job-fence -- <program> [arguments]\n", stderr);
    return USAGE_EXIT_CODE;
  }
  wchar_t *token = program_token(tail);
  if (!token || is_refused(token)) {
    fputs("seira-job-fence: will not start this program\n", stderr);
    free(token);
    return START_FAILED_EXIT_CODE;
  }
  wchar_t *program = resolve_program(token);
  free(token);
  if (!program || is_refused(program)) {
    fputs(program ? "seira-job-fence: will not start this program\n" : "seira-job-fence: could not find the program\n", stderr);
    free(program);
    return START_FAILED_EXIT_CODE;
  }
  size_t length = wcslen(tail);
  wchar_t *command = (wchar_t *)calloc(length + 1, sizeof(wchar_t));
  if (!command) { free(program); return START_FAILED_EXIT_CODE; }
  memcpy(command, tail, length * sizeof(wchar_t));

  wchar_t job_name[300];
  DWORD name_length = GetEnvironmentVariableW(FENCE_ENV, job_name, sizeof job_name / sizeof job_name[0]);
  SetEnvironmentVariableW(FENCE_ENV, NULL);
  HANDLE jobs[2];
  DWORD job_count = 0;
  HANDLE bots = name_length > 0 && name_length < sizeof job_name / sizeof job_name[0]
    ? OpenJobObjectW(JOB_OBJECT_ASSIGN_PROCESS, FALSE, job_name) : NULL;
  if (bots) jobs[job_count++] = bots;
  // Second in the list, so it nests inside the bots job. While this helper holds it, closing it stops its processes.
  HANDLE engine = CreateJobObjectW(NULL, NULL);
  if (engine) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info;
    memset(&info, 0, sizeof info);
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (SetInformationJobObject(engine, JobObjectExtendedLimitInformation, &info, sizeof info)) jobs[job_count++] = engine;
    else { CloseHandle(engine); engine = NULL; }
  }

  SetConsoleCtrlHandler(keep_waiting, TRUE);
  STARTUPINFOW own;
  GetStartupInfoW(&own);
  STARTUPINFOEXW start;
  memset(&start, 0, sizeof start);
  start.StartupInfo.cb = sizeof(STARTUPINFOW);
  start.StartupInfo.dwFlags = STARTF_USESTDHANDLES | (own.dwFlags & STARTF_USESHOWWINDOW);
  start.StartupInfo.wShowWindow = own.wShowWindow;
  start.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  start.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  start.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  // The C runtime's table of further inherited descriptors (stdio entries past 2) goes on unchanged.
  start.StartupInfo.cbReserved2 = own.cbReserved2;
  start.StartupInfo.lpReserved2 = own.lpReserved2;
  inherit(start.StartupInfo.hStdInput);
  inherit(start.StartupInfo.hStdOutput);
  inherit(start.StartupInfo.hStdError);
  // Without a console window here, a console program would open a new visible one.
  DWORD flags = GetConsoleWindow() ? 0 : CREATE_NO_WINDOW;

  PROCESS_INFORMATION child;
  memset(&child, 0, sizeof child);
  BOOL started = FALSE;
  DWORD error = 0;
  LPPROC_THREAD_ATTRIBUTE_LIST attributes = NULL;
  int initialized = 0, listed = 0;
  if (job_count) {
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(NULL, 1, 0, &size);
    attributes = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, size);
    initialized = attributes && InitializeProcThreadAttributeList(attributes, 1, 0, &size);
    listed = initialized && UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs, job_count * sizeof(HANDLE), NULL, NULL);
  }
  if (listed) {
    // The job list puts the program in the jobs at birth: no instruction of it runs outside the limit.
    start.StartupInfo.cb = sizeof start;
    start.lpAttributeList = attributes;
    started = CreateProcessW(program, command, NULL, NULL, TRUE, flags | EXTENDED_STARTUPINFO_PRESENT, NULL, NULL, &start.StartupInfo, &child);
    if (!started) error = GetLastError();
  } else {
    // Windows before the job list: start it paused, and let it run only once it is in every job.
    started = CreateProcessW(program, command, NULL, NULL, TRUE, flags | (job_count ? CREATE_SUSPENDED : 0), NULL, NULL, &start.StartupInfo, &child);
    if (!started) error = GetLastError();
    for (DWORD i = 0; started && i < job_count; i++) {
      if (AssignProcessToJobObject(jobs[i], child.hProcess)) continue;
      error = GetLastError();
      TerminateProcess(child.hProcess, START_FAILED_EXIT_CODE);
      CloseHandle(child.hThread);
      CloseHandle(child.hProcess);
      started = FALSE;
    }
    if (started && job_count) ResumeThread(child.hThread);
  }
  if (initialized) DeleteProcThreadAttributeList(attributes);
  if (attributes) HeapFree(GetProcessHeap(), 0, attributes);
  if (bots) CloseHandle(bots);
  free(command);
  free(program);
  if (!started) {
    if (engine) CloseHandle(engine);
    fprintf(stderr, "seira-job-fence: could not start the program (error %lu)\n", (unsigned long)error);
    return START_FAILED_EXIT_CODE;
  }
  CloseHandle(child.hThread);
  WaitForSingleObject(child.hProcess, INFINITE);
  DWORD code = START_FAILED_EXIT_CODE;
  GetExitCodeProcess(child.hProcess, &code);
  CloseHandle(child.hProcess);
  if (engine) {
    // The program ended on its own: processes it left behind keep running, as on Linux.
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info;
    memset(&info, 0, sizeof info);
    SetInformationJobObject(engine, JobObjectExtendedLimitInformation, &info, sizeof info);
    CloseHandle(engine);
  }
  return (int)code;
}

int wmain(int argc, wchar_t **argv) {
  InitializeCriticalSection(&out_lock);
  wchar_t path[MAX_PATH];
  DWORD length = GetModuleFileNameW(NULL, path, MAX_PATH);
  const wchar_t *base = path;
  for (DWORD i = 0; i < length; i++) if (path[i] == L'\\' || path[i] == L'/') base = path + i + 1;
  wcsncpy(self_name, length ? base : L"seira-job-fence.exe", MAX_PATH - 1);

  if (argc == 4 && wcscmp(argv[1], L"hold") == 0) return hold_main(argv[2], argv[3]);
  if (argc >= 3 && wcscmp(argv[1], L"--") == 0) return run_main();
  fputs("usage: seira-job-fence hold <job base name> <limit MiB>\n       seira-job-fence -- <program> [arguments]\n", stderr);
  return USAGE_EXIT_CODE;
}
