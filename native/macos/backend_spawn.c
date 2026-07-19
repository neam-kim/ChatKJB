#include <errno.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t supervisor_stop_signal = 0;

static void handle_supervisor_signal(int signal_number) {
    supervisor_stop_signal = signal_number;
}

static int append_environment(char **environment, size_t capacity, size_t *count, const char *name) {
    const char *value = getenv(name);
    if (value == NULL || value[0] == '\0') return 0;
    if (*count + 1 >= capacity) return E2BIG;
    size_t length = strlen(name) + strlen(value) + 2;
    char *entry = malloc(length);
    if (entry == NULL) return ENOMEM;
    if (snprintf(entry, length, "%s=%s", name, value) < 0) {
        free(entry);
        return EINVAL;
    }
    environment[(*count)++] = entry;
    return 0;
}

static int append_environment_value(
    char **environment,
    size_t capacity,
    size_t *count,
    const char *name,
    const char *value
) {
    if (value == NULL || value[0] == '\0') return EINVAL;
    if (*count + 1 >= capacity) return E2BIG;
    size_t length = strlen(name) + strlen(value) + 2;
    char *entry = malloc(length);
    if (entry == NULL) return ENOMEM;
    if (snprintf(entry, length, "%s=%s", name, value) < 0) {
        free(entry);
        return EINVAL;
    }
    environment[(*count)++] = entry;
    return 0;
}

static void free_environment(char **environment, size_t count) {
    for (size_t index = 0; index < count; index += 1) free(environment[index]);
}

static int make_sanitized_environment(
    char **environment,
    size_t capacity,
    size_t *environment_count,
    const char *working_directory
) {
    *environment_count = 0;
    environment[(*environment_count)++] = strdup("PATH=/usr/bin:/bin:/usr/sbin:/sbin");
    if (environment[0] == NULL) return ENOMEM;
    int result = append_environment_value(
        environment,
        capacity,
        environment_count,
        "CHATKJB_CONFIG_BASE_DIR",
        working_directory
    );
    if (result != 0) return result;
    const char *allowed_names[] = {"HOME", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE"};
    for (size_t index = 0; index < sizeof(allowed_names) / sizeof(allowed_names[0]); index += 1) {
        result = append_environment(environment, capacity, environment_count, allowed_names[index]);
        if (result != 0) return result;
    }
    environment[*environment_count] = NULL;
    return 0;
}

static double monotonic_seconds(void) {
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return 0;
    return (double)value.tv_sec + (double)value.tv_nsec / 1000000000.0;
}

static int status_exit_code(int status) {
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return 1;
}

static int stop_and_reap_node(pid_t node_pid) {
    int status = 0;
    pid_t waited = waitpid(node_pid, &status, WNOHANG);
    if (waited == node_pid) return status_exit_code(status);
    if (waited == -1 && errno == ECHILD) return 0;
    (void)kill(node_pid, SIGTERM);
    double deadline = monotonic_seconds() + 5.0;
    do {
        waited = waitpid(node_pid, &status, WNOHANG);
        if (waited == node_pid) return status_exit_code(status);
        if (waited == -1 && errno == ECHILD) return 0;
        usleep(50 * 1000);
    } while (monotonic_seconds() < deadline);
    (void)kill(node_pid, SIGKILL);
    while ((waited = waitpid(node_pid, &status, 0)) == -1 && errno == EINTR) {}
    return waited == node_pid ? status_exit_code(status) : 1;
}

int chatkjb_run_backend_supervisor(
    const char *node_path,
    const char *entry_path,
    const char *working_directory,
    int control_descriptor
) {
    if (node_path == NULL || entry_path == NULL || working_directory == NULL
        || control_descriptor < 3 || getpid() != getpgrp()) return EINVAL;
    const pid_t expected_parent_pid = getppid();
    if (expected_parent_pid <= 1) return ESRCH;

    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = handle_supervisor_signal;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, NULL) != 0
        || sigaction(SIGINT, &action, NULL) != 0
        || sigaction(SIGHUP, &action, NULL) != 0) return errno;

    posix_spawn_file_actions_t actions;
    posix_spawnattr_t attributes;
    int result = posix_spawn_file_actions_init(&actions);
    if (result != 0) return result;
    result = posix_spawnattr_init(&attributes);
    if (result != 0) goto cleanup_actions;
    result = posix_spawn_file_actions_addchdir_np(&actions, working_directory);
    if (result != 0) goto cleanup_attributes;
    result = posix_spawn_file_actions_adddup2(&actions, control_descriptor, 3);
    if (result != 0) goto cleanup_attributes;
    result = posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0);
    if (result != 0) goto cleanup_attributes;
    result = posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0);
    if (result != 0) goto cleanup_attributes;
    result = posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0);
    if (result != 0) goto cleanup_attributes;
    if (control_descriptor != 3) {
        result = posix_spawn_file_actions_addclose(&actions, control_descriptor);
        if (result != 0) goto cleanup_attributes;
    }

    short flags = POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETPGROUP;
    result = posix_spawnattr_setflags(&attributes, flags);
    if (result != 0) goto cleanup_attributes;
    result = posix_spawnattr_setpgroup(&attributes, getpgrp());
    if (result != 0) goto cleanup_attributes;

    char *arguments[] = {(char *)node_path, (char *)entry_path, "--control-fd", "3", NULL};
    char *environment[12] = {NULL};
    size_t environment_count = 0;
    result = make_sanitized_environment(environment, 12, &environment_count, working_directory);
    if (result != 0) {
        free_environment(environment, environment_count);
        goto cleanup_attributes;
    }
    pid_t node_pid = 0;
    result = posix_spawn(&node_pid, node_path, &actions, &attributes, arguments, environment);
    free_environment(environment, environment_count);

cleanup_attributes:
    posix_spawnattr_destroy(&attributes);
cleanup_actions:
    posix_spawn_file_actions_destroy(&actions);
    close(control_descriptor);
    if (result != 0) return result;

    for (;;) {
        int status = 0;
        pid_t waited = waitpid(node_pid, &status, WNOHANG);
        if (waited == node_pid) return status_exit_code(status);
        if (waited == -1 && errno != EINTR) return 1;
        if (supervisor_stop_signal != 0
            || getppid() != expected_parent_pid
            || (kill(expected_parent_pid, 0) != 0 && errno == ESRCH)) {
            return stop_and_reap_node(node_pid);
        }
        usleep(100 * 1000);
    }
}

int chatkjb_spawn_backend(
    const char *supervisor_path,
    const char *node_path,
    const char *entry_path,
    const char *working_directory,
    int *read_descriptor,
    pid_t *child_pid
) {
    if (supervisor_path == NULL || node_path == NULL || entry_path == NULL || working_directory == NULL
        || read_descriptor == NULL || child_pid == NULL) return EINVAL;

    int descriptors[2] = {-1, -1};
    if (pipe(descriptors) != 0) return errno;
    if (fcntl(descriptors[0], F_SETFD, FD_CLOEXEC) != 0
        || fcntl(descriptors[1], F_SETFD, FD_CLOEXEC) != 0) {
        int failure = errno;
        close(descriptors[0]);
        close(descriptors[1]);
        return failure;
    }

    posix_spawn_file_actions_t actions;
    posix_spawnattr_t attributes;
    int result = posix_spawn_file_actions_init(&actions);
    if (result != 0) goto cleanup_pipe;
    result = posix_spawnattr_init(&attributes);
    if (result != 0) goto cleanup_actions;

    result = posix_spawn_file_actions_addchdir_np(&actions, working_directory);
    if (result != 0) goto cleanup_attributes;
    result = posix_spawn_file_actions_addclose(&actions, descriptors[0]);
    if (result != 0) goto cleanup_attributes;
    result = posix_spawn_file_actions_adddup2(&actions, descriptors[1], 3);
    if (result != 0) goto cleanup_attributes;
    result = posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0);
    if (result != 0) goto cleanup_attributes;
    result = posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0);
    if (result != 0) goto cleanup_attributes;
    result = posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0);
    if (result != 0) goto cleanup_attributes;
    if (descriptors[1] != 3) {
        result = posix_spawn_file_actions_addclose(&actions, descriptors[1]);
        if (result != 0) goto cleanup_attributes;
    }

    short flags = POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETPGROUP;
    result = posix_spawnattr_setflags(&attributes, flags);
    if (result != 0) goto cleanup_attributes;
    result = posix_spawnattr_setpgroup(&attributes, 0);
    if (result != 0) goto cleanup_attributes;

    char *arguments[] = {
        (char *)supervisor_path,
        "--backend-supervisor",
        (char *)node_path,
        (char *)entry_path,
        (char *)working_directory,
        NULL
    };
    char *environment[12] = {NULL};
    size_t environment_count = 0;
    result = make_sanitized_environment(environment, 12, &environment_count, working_directory);
    if (result != 0) {
        free_environment(environment, environment_count);
        goto cleanup_attributes;
    }

    pid_t pid = 0;
    result = posix_spawn(&pid, supervisor_path, &actions, &attributes, arguments, environment);
    free_environment(environment, environment_count);
    if (result == 0) {
        close(descriptors[1]);
        descriptors[1] = -1;
        *read_descriptor = descriptors[0];
        *child_pid = pid;
        descriptors[0] = -1;
    }

cleanup_attributes:
    posix_spawnattr_destroy(&attributes);
cleanup_actions:
    posix_spawn_file_actions_destroy(&actions);
cleanup_pipe:
    if (descriptors[0] >= 0) close(descriptors[0]);
    if (descriptors[1] >= 0) close(descriptors[1]);
    return result;
}
