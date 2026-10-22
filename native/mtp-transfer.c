#include <libmtp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

// Small libmtp bridge. Release resolution and transaction management stay in TypeScript.
static LIBMTP_mtpdevice_t *device;
static uint32_t storage;
static const uint64_t max_bytes = 128ULL * 1024 * 1024;

static void fail(const char *message) {
  fprintf(stderr, "%s\n", message);
  if (device) {
    LIBMTP_Dump_Errorstack(device);
    LIBMTP_Release_Device(device);
  }
  exit(2);
}

static void validate(const char *path) {
  if (strncmp(path, "switch/", 7) || strlen(path) > 400) fail("Only SD-relative switch/ paths up to 400 bytes are supported");
  const char *part = path;
  for (const char *p = path; ; p++) {
    if ((unsigned char)*p < 32 && *p) fail("Unsafe path");
    if (strchr("\\:<>\"|?*", *p) && *p) fail("Unsafe path");
    if (*p == '/' || !*p) {
      size_t length = (size_t)(p - part);
      if (!length || (length == 1 && !strncmp(part, ".", 1)) ||
          (length == 2 && !strncmp(part, "..", 2)) || p[-1] == '.' || p[-1] == ' ') fail("Unsafe path component");
      if (!*p) break;
      part = p + 1;
    }
  }
}

static LIBMTP_file_t *resolve_path(const char *path) {
  char *copy = strdup(path), *save = NULL;
  uint32_t parent = LIBMTP_FILES_AND_FOLDERS_ROOT;
  LIBMTP_file_t *found = NULL;
  for (char *part = strtok_r(copy, "/", &save); part; part = strtok_r(NULL, "/", &save)) {
    LIBMTP_Clear_Errorstack(device);
    LIBMTP_file_t *files = LIBMTP_Get_Files_And_Folders(device, storage, parent);
    if (LIBMTP_Get_Errorstack(device)) fail("MTP directory listing failed");
    found = NULL;
    while (files) {
      LIBMTP_file_t *next = files->next;
      files->next = NULL;
      if (!strcasecmp(files->filename, part)) {
        if (found) fail("Ambiguous filename on SD card");
        found = files;
      } else LIBMTP_destroy_file_t(files);
      files = next;
    }
    if (!found) { free(copy); return NULL; }
    parent = found->item_id;
    if (save && *save) {
      if (found->filetype != LIBMTP_FILETYPE_FOLDER) fail("Path traverses a file");
      LIBMTP_destroy_file_t(found);
      found = NULL;
    }
  }
  free(copy);
  return found;
}

static void require_file(LIBMTP_file_t *file) {
  if (file->filetype == LIBMTP_FILETYPE_FOLDER || file->filesize > max_bytes) fail("Expected a regular file no larger than 128 MiB");
}

static int equal_files(const char *left, const char *right) {
  FILE *a = fopen(left, "rb"), *b = fopen(right, "rb");
  if (!a || !b) fail("Cannot open local verification file");
  unsigned char x[8192], y[8192];
  int equal = 1;
  for (;;) {
    size_t n = fread(x, 1, sizeof(x), a), m = fread(y, 1, sizeof(y), b);
    if (n != m || memcmp(x, y, n)) { equal = 0; break; }
    if (!n) break;
  }
  if (ferror(a) || ferror(b)) equal = 0;
  fclose(a);
  fclose(b);
  return equal;
}

static void verify(LIBMTP_file_t *file, const char *local) {
  char *temporary = malloc(strlen(local) + 32);
  if (!temporary) fail("Out of memory");
  sprintf(temporary, "%s.verify-XXXXXX", local);
  int fd = mkstemp(temporary);
  if (fd < 0) fail("Cannot create verification file");
  close(fd);
  if (LIBMTP_Get_File_To_File(device, file->item_id, temporary, NULL, NULL)) fail("MTP readback failed");
  if (!equal_files(local, temporary)) fail("MTP readback differs from upload");
  unlink(temporary);
  free(temporary);
}

static uint32_t ensure_parent(const char *path) {
  char *copy = strdup(path), *save = NULL, built[512] = "";
  uint32_t parent = LIBMTP_FILES_AND_FOLDERS_ROOT;
  for (char *part = strtok_r(copy, "/", &save); part; part = strtok_r(NULL, "/", &save)) {
    if (*built) strcat(built, "/");
    strcat(built, part);
    LIBMTP_file_t *file = resolve_path(built);
    if (file) {
      if (file->filetype != LIBMTP_FILETYPE_FOLDER) fail("Parent is not a folder");
      parent = file->item_id;
      LIBMTP_destroy_file_t(file);
    } else {
      parent = LIBMTP_Create_Folder(device, part, parent, storage);
      if (!parent) fail("Cannot create MTP folder");
    }
  }
  free(copy);
  return parent;
}

static void upload(const char *remote, const char *local, int exclusive) {
  struct stat info;
  if (stat(local, &info) || !S_ISREG(info.st_mode) || info.st_size < 0 || (uint64_t)info.st_size > max_bytes) fail("Invalid local upload file");
  LIBMTP_file_t *old = resolve_path(remote);
  if (old) {
    require_file(old);
    if (exclusive) fail("Backup destination already exists");
  }
  char *parent_path = strdup(remote), *base = strrchr(parent_path, '/');
  *base++ = 0;
  uint32_t parent = ensure_parent(parent_path);
  char temp_name[512], old_name[512], temp_path[512], old_path[512];
  snprintf(temp_name, sizeof(temp_name), "%s.switchpack-tmp", base);
  snprintf(old_name, sizeof(old_name), "%s.switchpack-before", base);
  snprintf(temp_path, sizeof(temp_path), "%s.switchpack-tmp", remote);
  snprintf(old_path, sizeof(old_path), "%s.switchpack-before", remote);
  if (resolve_path(temp_path) || resolve_path(old_path)) fail("Pending .switchpack-tmp or .switchpack-before exists; inspect it before retrying");
  LIBMTP_file_t *file = LIBMTP_new_file_t();
  file->filename = strdup(temp_name);
  file->filesize = info.st_size;
  file->parent_id = parent;
  file->storage_id = storage;
  file->filetype = LIBMTP_FILETYPE_UNKNOWN;
  file->modificationdate = time(NULL);
  if (LIBMTP_Send_File_From_File(device, local, file, NULL, NULL)) fail("MTP upload failed");
  LIBMTP_destroy_file_t(file);
  file = resolve_path(temp_path);
  if (!file || file->filesize != (uint64_t)info.st_size) fail("Uploaded file size mismatch");
  verify(file, local);
  if (old && LIBMTP_Set_File_Name(device, old, old_name)) fail("Cannot preserve previous target");
  if (LIBMTP_Set_File_Name(device, file, base)) {
    if (old) LIBMTP_Set_File_Name(device, old, base);
    fail("Cannot promote verified upload");
  }
  LIBMTP_destroy_file_t(file);
  file = resolve_path(remote);
  if (!file || file->filesize != (uint64_t)info.st_size) fail("Final target size mismatch");
  verify(file, local);
  LIBMTP_destroy_file_t(file);
  if (old) {
    if (LIBMTP_Delete_Object(device, old->item_id)) fail("Cannot remove temporary previous target; backup retained");
    LIBMTP_destroy_file_t(old);
  }
  free(parent_path);
}

int main(int argc, char **argv) {
  if (argc < 3 || (strcmp(argv[1], "delete") ? argc != 4 : argc != 3)) {
    fprintf(stderr, "Usage: switchpack-mtp read|write|create <remote> <local>, or delete <remote>\n");
    return 1;
  }
  const char *action = argv[1], *remote = argv[2];
  if (strcmp(action, "read") && strcmp(action, "write") && strcmp(action, "create") && strcmp(action, "delete")) return 1;
  validate(remote);
  LIBMTP_Init();
  LIBMTP_raw_device_t *raw = NULL;
  int count = 0;
  if (LIBMTP_Detect_Raw_Devices(&raw, &count) || count != 1) fail("Connect exactly one MTP device with DBI's MTP responder running");
  if (raw->device_entry.vendor_id != 0x057e) fail("Connected MTP device is not a Nintendo Switch");
  device = LIBMTP_Open_Raw_Device_Uncached(raw);
  free(raw);
  if (!device) fail("Cannot open MTP device");
  if (LIBMTP_Get_Storage(device, 0)) fail("Cannot list MTP storage");
  for (LIBMTP_devicestorage_t *s = device->storage; s; s = s->next) {
    if (s->StorageDescription && !strcmp(s->StorageDescription, "1: SD Card")) {
      if (storage) fail("Ambiguous DBI SD storage");
      storage = s->id;
    }
  }
  if (!storage) fail("DBI storage '1: SD Card' not found");
  int result = 0;
  if (!strcmp(action, "read") || !strcmp(action, "delete")) {
    LIBMTP_file_t *file = resolve_path(remote);
    if (!file) result = 3;
    else {
      require_file(file);
      if (!strcmp(action, "read")) {
        if (LIBMTP_Get_File_To_File(device, file->item_id, argv[3], NULL, NULL)) fail("MTP download failed");
      } else if (LIBMTP_Delete_Object(device, file->item_id)) fail("MTP delete failed");
      LIBMTP_destroy_file_t(file);
    }
  } else upload(remote, argv[3], !strcmp(action, "create"));
  LIBMTP_Release_Device(device);
  return result;
}
