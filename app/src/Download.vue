<template lang="pug">
  .download-app
    a.btn.btn-sm.btn-info.btn-new-session(@click='newSession()', :title='$root.lang.newUpload')
      icon.fa-fw(name="cloud-upload-alt")
      span.hidden-xs  {{ $root.lang.newUpload }}
    .alert.alert-danger(v-show="error")
      strong
        icon.fa-fw(name="exclamation-triangle")
        |  {{ error }}
    .well(v-if='needsPassword')
      h3 {{ $root.lang.password }}
      .form-group
        input.form-control(type='password', v-model='password', @keyup.enter='password.length && fetchBucket()' autofocus)
      p.text-danger(v-show='passwordWrong')
        strong {{ $root.lang.accessDenied }}
      |
      button.decrypt.btn.btn-primary(:disabled='password.length<1', @click='fetchBucket()')
        icon.fa-fw(name="key")
        |  {{ $root.lang.decrypt }}
    .panel.panel-primary(v-if='!needsPassword && !loading')
      .panel-heading
        strong {{ $root.lang.files }}
        div.pull-right.btn-group.btn-download-archive(v-if="downloadsAvailable")
          a.btn.btn-sm.btn-default(
            @click="downloadAll('zip')"
            @keydown.enter.prevent="downloadAll('zip')"
            @keydown.space.prevent="downloadAll('zip')"
            :title="$root.lang.zipDownload"
            tabindex="0"
            role="button"
          )
            icon.fa-fw(name="download")
            |  zip
          a.btn.btn-sm.btn-default(
            @click="downloadAll('tar.gz')"
            @keydown.enter.prevent="downloadAll('tar.gz')"
            @keydown.space.prevent="downloadAll('tar.gz')"
            :title="$root.lang.tarGzDownload"
            tabindex="0"
            role="button"
          )
            icon.fa-fw(name="download")
            |  tar.gz
      .panel-body
        table.table.table-hover.table-striped.files
          tbody
            tr(
              v-for='file in files',
              style='cursor: pointer',
              @click='download(file)',
              @keydown.enter.prevent='download(file)',
              @keydown.space.prevent='download(file)',
              tabindex="0",
              role="button"
            )
              td.file-icon
                file-icon(:file='file')
              td
                div.pull-right.btn-group
                  clipboard.btn.btn-sm.btn-default(:value='baseURI + file.url', @change='copied(file, $event)', :title='$root.lang.copyToClipboard')
                    a
                      icon(name="copy")
                  a.btn.btn-sm.btn-default(:title="$root.lang.preview", @click.prevent.stop="preview=file", v-if="file.previewType")
                    icon(name="eye")
                i.pull-right.fa.fa-check.text-success.downloaded(v-show='file.downloaded')
                p
                  strong {{ file.metadata.name }}
                  small.file-size(v-if="isFinite(file.size)") ({{ humanFileSize(file.size) }})
                p {{ file.metadata.comment }}
                div(v-if='file.chunkedRunning')
                  .progress(style='margin-bottom:6px; max-width:280px')
                    .progress-bar.progress-bar-striped.active(
                      role='progressbar',
                      :style='{width: (file.progressPct || 0) + "%"}'
                    ) {{ file.progressPct || 0 }}%
                  p.text-muted(v-show='file.statusText', style='margin-bottom:0')
                    strong {{ file.statusText }}

    preview-modal(:preview="preview", :files="previewFiles", :max-size="config.maxPreviewSize", @close="preview=false")

</template>


<script>
  "use strict";

  import FileIcon from './common/FileIcon.vue';
  import Clipboard from './common/Clipboard.vue';
  import PreviewModal from './Download/PreviewModal.vue';

  import 'vue-awesome/icons/cloud-upload-alt';
  import 'vue-awesome/icons/exclamation-triangle';
  import 'vue-awesome/icons/copy';
  import 'vue-awesome/icons/check';
  import 'vue-awesome/icons/download';
  import 'vue-awesome/icons/key';
  import 'vue-awesome/icons/eye';

  function getPreviewType(file, maxSize) {
    if(!file || !file.metadata) return false;
    if(file.metadata.retention === 'one-time') return false;
    // no preview for files size > 2MB
    if(file.size > maxSize) return false;
    if(file.metadata.type && file.metadata.type.match(/^image\/.*/)) return 'image';
    else if(file.metadata.type && file.metadata.type.match(/(text\/|xml|json|javascript|x-sh)/)
      || file.metadata.name && file.metadata.name
        .match(/\.(jsx|vue|sh|pug|less|scss|sass|c|h|conf|log|bat|cmd|lua|class|java|py|php|yml|sql|md)$/)) {
      return 'text';
    }
    return false;
  }

  export default {
    name: 'app',
    components: { FileIcon, Clipboard, PreviewModal },
    data () {
      return {
        files: [],
        sid: document.location.pathname.match(/^.*\/([^\/?#]+)/)[1],
        baseURI: this.$root.baseURI,
        passwordWrong: false,
        needsPassword: false,
        loading: true,
        password: '',
        content: '',
        error: '',
        config: {},
        archiveToken: '',
        preview: false
      }
    },

    computed: {
      downloadsAvailable: function() {
        if (!this.archiveToken) return false;
        return this.files.filter(f => !f.downloaded || f.metadata.retention !== 'one-time').length > 0
      },
      previewFiles: function() {
        return this.files.filter(f => !!f.previewType);
      }

    },

    methods: {

      download(file) {
        if(file.downloaded && file.metadata.retention === 'one-time') {
          alert(this.$root.lang.oneTimeDownloadExpired);
          return;
        }
        if (file.chunkedRunning) return;
        // small files (or no size info): plain browser download
        if (!this.isFinite(file.size) || file.size <= 12 * 1024 * 1024) {
          const aEl = document.createElement('a');
          aEl.setAttribute('href', file.url);
          aEl.setAttribute('download', file.metadata.name);
          aEl.style.display = 'none';
          document.body.appendChild(aEl);
          aEl.click();
          document.body.removeChild(aEl);
          file.downloaded = true;
          return;
        }
        this.chunkedDownload(file);
      },

      // Relay-proof download: walk the file in HTTP Range chunks (well below
      // the proxy per-response cut) and assemble client-side, with automatic
      // resume on network errors. Streams straight to disk when the File
      // System Access API is available, falls back to an in-memory Blob.
      async chunkedDownload(file) {
        const MIN_CHUNK = 512 * 1024;
        const MAX_CHUNK = 16 * 1024 * 1024;
        const TARGET_SECONDS = 50; // stay well within the ~80s relay cut
        this.$set(file, 'chunkedRunning', true);
        this.$set(file, 'progressPct', 0);
        this.$set(file, 'statusText', 'downloading…');

        let writable = null;
        const parts = [];
        let offset = 0;
        try {
          if (window.showSaveFilePicker) {
            try {
              const handle = await window.showSaveFilePicker({
                suggestedName: file.metadata.name,
                types: [{ description: 'File', accept: { 'application/octet-stream': ['.*'] } }],
              });
              writable = await handle.createWritable();
            } catch (e) {
              if (e && (e.name === 'AbortError')) {
                this.$delete(file, 'chunkedRunning');
                return;
              }
              writable = null; // fall back to Blob
            }
          }
          if (!writable && file.size > 1536 * 1024 * 1024) {
            console.warn('File System Access API unavailable; large blob download may use a lot of memory.');
          }

          let rate = 262 * 1024; // measured on the Olares relay; refined after first chunk
          let chunkSize = Math.max(MIN_CHUNK, Math.min(MAX_CHUNK, rate * TARGET_SECONDS));
          sinceRetry: while (offset < file.size) {
            const start = offset;
            const end = Math.min(file.size - 1, offset + chunkSize - 1);
            for (let attempt = 0; attempt < 6; attempt++) {
              const t0 = Date.now();
              let resp;
              try {
                resp = await fetch(file.url, {
                  headers: start === 0 && end >= file.size - 1
                    ? {}
                    : { Range: `bytes=${ start }-${ end }` },
                  cache: 'no-store',
                });
              } catch (e) {
                if (attempt === 5) throw e;
                await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
                continue;
              }
              if (resp.status === 200 && start === 0 && end >= file.size - 1) {
                // whole-file response without Range support: consume as-is
                if (writable) await resp.body.pipeTo(writable);
                else parts.push(await resp.arrayBuffer());
                offset = file.size;
                this.$set(file, 'progressPct', 100);
                break sinceRetry;
              }
              if (resp.status !== 206) {
                if (attempt === 5) throw new Error(`unexpected HTTP ${ resp.status } for Range ${ start }-${ end }`);
                await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
                continue;
              }
              const buf = await resp.arrayBuffer();
              if (writable) await writable.write(buf);
              else parts.push(buf);
              offset += buf.byteLength;
              const took = (Date.now() - t0) / 1000;
              if (buf.byteLength > 0) {
                rate = buf.byteLength / Math.max(took, 0.05);
                // adapt chunk size to stay inside the relay deadline
                chunkSize = Math.max(MIN_CHUNK, Math.min(MAX_CHUNK, Math.floor(rate * TARGET_SECONDS)));
              }
              this.$set(file, 'progressPct', Math.min(100, Math.round((offset / file.size) * 100)));
              break;
            }
          }
          if (writable) await writable.close();
          const blob = new Blob(parts, { type: 'application/octet-stream' });
          const aEl = document.createElement('a');
          aEl.setAttribute('href', URL.createObjectURL(blob));
          aEl.setAttribute('download', file.metadata.name);
          aEl.style.display = 'none';
          document.body.appendChild(aEl);
          aEl.click();
          document.body.removeChild(aEl);
          setTimeout(() => URL.revokeObjectURL(aEl.href), 60000);
          offset = file.size;
          file.downloaded = true;
          this.$set(file, 'statusText', 'done');
        } catch (e) {
          console.error(e);
          this.$set(file, 'statusText', `failed: ${ e.message || e } - click to retry`);
          file.downloaded = false;
        } finally {
          this.$set(file, 'chunkedRunning', false);
          if (offset >= file.size) {
            setTimeout(() => this.$delete(file, 'statusText'), 4000);
          }
        }
      },

      async downloadAll(format) {
        let token = this.archiveToken;
        if (!token) {
          console.error('Archive token not found.');
          return;
        }
        document.location.href = this.$root.baseURI
          + '/files/' + this.sid + '++'
          + this.archiveToken + '.' + format;
        this.files.forEach(f => { f.downloaded = true; })
      },

      copied(file, $event) {
        file.downloaded = $event === 'copied';
      },

      humanFileSize(fileSizeInBytes) {
        let i = -1;
        const byteUnits = [' kB', ' MB', ' GB', ' TB', 'PB', 'EB', 'ZB', 'YB'];
        let size = fileSizeInBytes;
        do {
          size = size / 1024;
          i++;
        }
        while(size > 1024);
        return Math.max(size, 0.01).toFixed(2) + byteUnits[i];
      },

      newSession() {
        document.location.href = this.$root.baseURI;
      },

      isFinite(value) {
        if(typeof value !== 'number') return false;
        return !(value !== value || value === Infinity || value === -Infinity);
      },

      fetchBucket() {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', this.sid + '.json');
        if(this.password) {
          xhr.setRequestHeader('x-download-pass', this.password);
        }
        xhr.onload = () => {
          if (xhr.status === 200) {
            try {
              const data = JSON.parse(xhr.responseText);
              this.config = data.config;
              this.archiveToken = data.archiveToken || '';
              this.files = data.items.map(f => {
                return Object.assign(f, {
                  downloaded: false,
                  previewType: getPreviewType(f, this.config.maxPreviewSize)
                });
              });
              this.loading = false;
              this.needsPassword = false;
            }
            catch (e) {
              this.error = e.toString();
            }
          } else if (xhr.status === 401) {
            if(this.needsPassword) {
              this.passwordWrong = true;
            } else {
              this.needsPassword = true;
            }
            this.loading = false;
          } else {
            this.error = `${ xhr.status } ${ xhr.statusText }: ${ xhr.responseText }`;
          }
        };
        xhr.send();
      },
    },

    beforeMount() {
      this.fetchBucket();
    }
  }
</script>
