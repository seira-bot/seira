// A test program for seira-job-fence. It is never shipped.
//   test-eater retry <chunk MiB>   commits memory in chunks for ever, and tries again after each refusal
//   test-eater hold <MiB>          commits that much, prints "held <MiB>", then waits
//   test-eater injob               prints whether it runs in a job and the job's memory limit, as JSON
//   test-eater child <mode> ...    runs itself with the other arguments and exits with that run's exit code
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
}

static int hold(unsigned long mib) {
  for (unsigned long done = 0; done < mib; done += 16) {
    while (!commit((SIZE_T)16 << 20)) Sleep(20);
  }
  printf("held %lu\n", mib);
  fflush(stdout);
  Sleep(INFINITE);
  return 0;
}

static int injob(void) {
  BOOL in_job = FALSE;
  IsProcessInJob(GetCurrentProcess(), NULL, &in_job);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION info;
  memset(&info, 0, sizeof info);
  unsigned long long limit = 0;
  // A null job names the job of this process.
  if (in_job && QueryInformationJobObject(NULL, JobObjectExtendedLimitInformation, &info, sizeof info, NULL)
      && (info.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_JOB_MEMORY))
    limit = info.JobMemoryLimit;
  printf("{\"inJob\":%s,\"jobMemoryLimit\":%llu}\n", in_job ? "true" : "false", limit);
  fflush(stdout);
  return 0;
}

static int child(void) {
  // The command line after "child": the same program with the remaining arguments.
  const wchar_t *line = GetCommandLineW();
  const wchar_t *rest = wcsstr(line, L" child ");
  if (!rest) return 2;
  rest += 7;
  wchar_t path[MAX_PATH];
  GetModuleFileNameW(NULL, path, MAX_PATH);
  size_t size = wcslen(path) + wcslen(rest) + 4;
  wchar_t *command = (wchar_t *)calloc(size, sizeof(wchar_t));
  if (!command) return 2;
  swprintf(command, size, L"\"%ls\" %ls", path, rest);
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

int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "retry") == 0) return retry(strtoul(argv[2], NULL, 10));
  if (argc == 3 && strcmp(argv[1], "hold") == 0) return hold(strtoul(argv[2], NULL, 10));
  if (argc == 2 && strcmp(argv[1], "injob") == 0) return injob();
  if (argc >= 3 && strcmp(argv[1], "child") == 0) return child();
  fputs("usage: test-eater retry <MiB> | hold <MiB> | injob | child <mode> ...\n", stderr);
  return 2;
}
