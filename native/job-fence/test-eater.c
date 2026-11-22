// A test program for seira-job-fence. It is never shipped.
//   test-eater retry <chunk MiB>   commits memory in chunks for ever, and tries again after each refusal
//   test-eater hold <MiB>          commits that much, prints "held <MiB> <pid>", then waits
//   test-eater injob               prints, as JSON, whether it runs in the job that EATER_JOB names, that job's memory
//                                  limit, and whether its own innermost job stops its processes when the job closes
//   test-eater child <mode> ...    runs itself with the other arguments and exits with that run's exit code
//   test-eater spawn <mode> ...    starts itself with the other arguments, prints "spawned <pid>", and exits at once
//   test-eater ask <MiB> <MiB>     commits the first amount, asks once for the second, prints "asked granted" or
//                                  "asked refused", then waits
#define WIN32_LEAN_AND_MEAN
#define __USE_MINGW_ANSI_STDIO 1
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

static int commit(SIZE_T bytes) {
  char *memory = (char *)VirtualAlloc(NULL, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
  if (!memory) return 0;
  // Touch every page, so the memory is in use and not only promised.
  for (SIZE_T at = 0; at < bytes; at += 4096) memory[at] = 1;
  return 1;
}

static int retry(unsigned long chunk_mib) {
  for (;;) {
    if (!commit((SIZE_T)chunk_mib << 20)) Sleep(20);
  }
  return 0;
}

static int hold(unsigned long mib) {
  for (unsigned long done = 0; done < mib; done += 16) {
    while (!commit((SIZE_T)16 << 20)) Sleep(20);
  }
  printf("held %lu %lu\n", mib, (unsigned long)GetCurrentProcessId());
  fflush(stdout);
  Sleep(INFINITE);
  return 0;
}

static int ask(unsigned long hold_mib, unsigned long request_mib) {
  for (unsigned long done = 0; done < hold_mib; done += 16) {
    while (!commit((SIZE_T)16 << 20)) Sleep(20);
  }
  void *memory = VirtualAlloc(NULL, (SIZE_T)request_mib << 20, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
  printf("asked %s\n", memory ? "granted" : "refused");
  fflush(stdout);
  Sleep(INFINITE);
  return 0;
}

static int injob(void) {
  BOOL in_job = FALSE;
  unsigned long long limit = 0;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION info;
  const char *name = getenv("EATER_JOB");
  HANDLE job = name ? OpenJobObjectA(JOB_OBJECT_QUERY, FALSE, name) : NULL;
  if (job) {
    IsProcessInJob(GetCurrentProcess(), job, &in_job);
    memset(&info, 0, sizeof info);
    if (QueryInformationJobObject(job, JobObjectExtendedLimitInformation, &info, sizeof info, NULL)
        && (info.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_JOB_MEMORY))
      limit = info.JobMemoryLimit;
    CloseHandle(job);
  }
  // A null job names the innermost job of this process.
  BOOL in_any = FALSE;
  IsProcessInJob(GetCurrentProcess(), NULL, &in_any);
  memset(&info, 0, sizeof info);
  int kill_on_close = in_any && QueryInformationJobObject(NULL, JobObjectExtendedLimitInformation, &info, sizeof info, NULL)
    && (info.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);
  printf("{\"inJob\":%s,\"jobMemoryLimit\":%llu,\"killOnClose\":%s}\n", in_job ? "true" : "false", limit,
    kill_on_close ? "true" : "false");
  fflush(stdout);
  return 0;
}

// The same program with the arguments after `word`.
static wchar_t *self_command(const wchar_t *word) {
  const wchar_t *line = GetCommandLineW();
  const wchar_t *rest = wcsstr(line, word);
  if (!rest) return NULL;
  rest += wcslen(word);
  wchar_t path[MAX_PATH];
  GetModuleFileNameW(NULL, path, MAX_PATH);
  size_t size = wcslen(path) + wcslen(rest) + 4;
  wchar_t *command = (wchar_t *)calloc(size, sizeof(wchar_t));
  if (command) swprintf(command, size, L"\"%ls\" %ls", path, rest);
  return command;
}

static int child(void) {
  wchar_t *command = self_command(L" child ");
  if (!command) return 2;
  STARTUPINFOW start;
  memset(&start, 0, sizeof start);
  start.cb = sizeof start;
  PROCESS_INFORMATION process;
  if (!CreateProcessW(NULL, command, NULL, NULL, TRUE, 0, NULL, NULL, &start, &process)) return 2;
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD code = 2;
  GetExitCodeProcess(process.hProcess, &code);
  return (int)code;
}

static int spawn_self(void) {
  wchar_t *command = self_command(L" spawn ");
  if (!command) return 2;
  STARTUPINFOW start;
  memset(&start, 0, sizeof start);
  start.cb = sizeof start;
  PROCESS_INFORMATION process;
  // No inherited handles: the caller's pipes close when this process ends, while the new one keeps running.
  if (!CreateProcessW(NULL, command, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &start, &process)) return 2;
  printf("spawned %lu\n", (unsigned long)process.dwProcessId);
  fflush(stdout);
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "retry") == 0) return retry(strtoul(argv[2], NULL, 10));
  if (argc == 3 && strcmp(argv[1], "hold") == 0) return hold(strtoul(argv[2], NULL, 10));
  if (argc == 2 && strcmp(argv[1], "injob") == 0) return injob();
  if (argc == 4 && strcmp(argv[1], "ask") == 0) return ask(strtoul(argv[2], NULL, 10), strtoul(argv[3], NULL, 10));
  if (argc >= 3 && strcmp(argv[1], "child") == 0) return child();
  if (argc >= 3 && strcmp(argv[1], "spawn") == 0) return spawn_self();
  fputs("usage: test-eater retry <MiB> | hold <MiB> | injob | child <mode> ... | spawn <mode> ... | ask <MiB> <MiB>\n", stderr);
  return 2;
}
