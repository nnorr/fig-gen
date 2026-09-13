// fig-gen test fixture (self-written): an APB slave with two registers at 0x0
// and 0x4, a one-cycle pready wait on every access.
module apb_reg (
  input  logic        pclk,
  input  logic        presetn,
  input  logic        psel,
  input  logic        penable,
  input  logic        pwrite,
  input  logic [7:0]  paddr,
  input  logic [31:0] pwdata,
  output logic [31:0] prdata,
  output logic        pready
);
  logic [31:0] r0, r1;
  logic        wait_q;
  always_ff @(posedge pclk or negedge presetn) begin
    if (!presetn) begin
      r0 <= 32'd0;
      r1 <= 32'd0;
      wait_q <= 1'b0;
    end else begin
      wait_q <= psel && penable && !wait_q;
      if (psel && penable && wait_q && pwrite) begin
        if (paddr[2]) r1 <= pwdata;
        else r0 <= pwdata;
      end
    end
  end
  assign pready = wait_q;
  assign prdata = paddr[2] ? r1 : r0;
endmodule
