/* Experimental MCP byte bridge. The peer socket must implement the MCP server.
 * Build: clang -O2 -std=c11 -Wall -Wextra -Werror -pthread -o mcp-bridge examples/mcp-bridge.c
 * Run:   mcp-bridge /path/to/owned/socket
 * No agent-mail client configuration uses this prototype. */
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

static int forward_bytes(int source, int destination) {
    unsigned char buffer[8192];
    for (;;) {
        ssize_t count = read(source, buffer, sizeof(buffer));
        if (count == 0) return 0;
        if (count < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        for (ssize_t sent = 0; sent < count;) {
            ssize_t written = write(destination, buffer + sent, (size_t)(count - sent));
            if (written < 0 && errno == EINTR) continue;
            if (written <= 0) return -1;
            sent += written;
        }
    }
}

struct inbound {
    int socket_fd;
    atomic_int failed;
};

static void *stdin_to_socket(void *context) {
    struct inbound *pipe = context;
    if (forward_bytes(STDIN_FILENO, pipe->socket_fd) < 0) {
        atomic_store(&pipe->failed, 1);
        shutdown(pipe->socket_fd, SHUT_RDWR);
    } else {
        shutdown(pipe->socket_fd, SHUT_WR);
    }
    return NULL;
}

int main(int argc, char **argv) {
    struct sockaddr_un address = { .sun_family = AF_UNIX };
    if (argc != 2 || strlen(argv[1]) >= sizeof(address.sun_path)) {
        fputs("usage: mcp-bridge /path/to/owned/socket\n", stderr);
        return 2;
    }
    memcpy(address.sun_path, argv[1], strlen(argv[1]) + 1);
    signal(SIGPIPE, SIG_IGN);

    int socket_fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (socket_fd < 0) {
        perror("socket");
        return 1;
    }
    if (connect(socket_fd, (struct sockaddr *)&address, sizeof(address)) < 0) {
        perror("connect");
        close(socket_fd);
        return 1;
    }

    struct inbound pipe = { .socket_fd = socket_fd, .failed = 0 };
    pthread_t reader;
    int error = pthread_create(&reader, NULL, stdin_to_socket, &pipe);
    if (error != 0) {
        errno = error;
        perror("pthread_create");
        close(socket_fd);
        return 1;
    }
    /* Socket EOF terminates the process, including a worker blocked on stdin. */
    int result = forward_bytes(socket_fd, STDOUT_FILENO);
    if (result < 0 || atomic_load(&pipe.failed))
        fputs("mcp-bridge: relay failed\n", stderr);
    close(socket_fd);
    return result < 0 || atomic_load(&pipe.failed) ? 1 : 0;
}
